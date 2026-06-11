import type { ControlInput, VehicleSnapshot } from '@trace/physics';
import type { InputActive } from './input';
import { FIXED_DT } from './loop';

/**
 * Dev-mode race telemetry recorder.
 *
 * Captures a full race — start (`start()`) to finish (`stop()`) — as a flat
 * table of per-fixed-step samples plus the contact impacts ("hits") harvested
 * each step. The session feeds it inside the fixed loop; the dev HUD drives
 * start/stop and downloads the result as CSV.
 *
 * Two consumers shape what we record:
 *   - **Analytics / ELO** — speed, position, heading, input pressure, and where
 *     the car got hit and how hard, sampled at the physics rate (60 Hz).
 *   - **Replay** — every row carries the exact discrete chassis pose (position +
 *     quaternion), the {@link ControlInput} fed to the controller that step, and
 *     the raw arrow-key state (the bike's lean/steer keys). Rows additionally
 *     hold the per-wheel visual pose (hub position, steer angle, spin) so the
 *     in-session 3D replay player can pose the vehicle visual frame-for-frame;
 *     that wheel detail lives in memory only (it would bloat the CSV) and is
 *     surfaced through {@link TelemetryRecorder.getReplay}. The CSV keeps the
 *     analytics columns — pose, inputs, arrow keys, and hits — behind a
 *     `#`-commented metadata header (zone, vehicle, spawn, fixed_dt).
 *
 * Recording is opt-in dev tooling: the session only calls into the recorder
 * while {@link recording} is true, so normal play keeps its zero-allocation hot
 * path. While recording, one small row object is allocated per step — acceptable
 * for a developer capture and never on the default path.
 */

/** Per-wheel visual pose recorded for the 3D replay (the subset the renderer's
 * `applySnapshot` consumes). Lives in memory only — not serialized to the CSV. */
export type ReplayWheel = {
  position: { x: number; y: number; z: number };
  /** Steering angle in radians; positive = right. */
  steering: number;
  /** Cumulative spin angle in radians. */
  rotation: number;
  inContact: boolean;
};

/** One physics-step sample. `step` is the fixed-step index; `t = step * FIXED_DT`. */
export type TelemetryStep = {
  step: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /** Forward speed (m/s). */
  speed: number;
  /** Yaw heading in degrees — 0° = +Z, clockwise positive. */
  heading: number;
  throttle: number;
  brake: number;
  steering: number;
  handbrake: number;
  reset: boolean;
  /** Raw arrow keys held this step — the bike's lean (↑/↓) + steer (←/→). */
  up: boolean;
  down: boolean;
  arrowLeft: boolean;
  arrowRight: boolean;
  /** Per-wheel visual pose — drives the in-session 3D replay (not in the CSV). */
  wheels: ReplayWheel[];
};

/** One frame of the in-memory 3D replay — exactly what the renderer's
 * `applySnapshot` needs (chassis pose + speed + per-wheel pose). */
export type ReplayFrame = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  speed: number;
  wheels: ReplayWheel[];
};

/** A finished capture, ready to feed the replay player. */
export type ReplayCapture = {
  meta: TelemetryMeta;
  /** Seconds per recorded frame (`FIXED_DT`) — the replay clock's frame pitch. */
  fixedDt: number;
  frames: ReplayFrame[];
};

/** Aggregated chassis impacts that landed on a single step. */
type StepHits = {
  count: number;
  /** Strongest contact magnitude this step. */
  maxMagnitude: number;
  /** World-space contact point of the strongest hit. */
  point: { x: number; y: number; z: number };
};

export type TelemetryMeta = {
  zoneId: string;
  zoneVersion: string;
  vehicleId: string;
  vehicleVersion: string;
  /** Spawn pose, so a replay can seat the car before feeding inputs. */
  spawn: { position: readonly [number, number, number]; rotation: readonly [number, number, number, number] };
};

export type TelemetrySummary = {
  recording: boolean;
  frameCount: number;
  hitCount: number;
  /** Seconds of race captured (`frameCount * FIXED_DT`). */
  durationS: number;
};

export type TelemetryRecorder = {
  readonly recording: boolean;
  /** Number of step rows captured so far. */
  readonly frameCount: number;
  /** Begin a fresh capture. Discards any previously recorded data. */
  start(): void;
  /** Stop capturing. The recorded data stays available for {@link buildCsv}. */
  stop(): void;
  /** Record one fixed-step sample. No-op unless recording. Called from the loop's `step`. */
  recordStep(
    step: number,
    snapshot: VehicleSnapshot,
    input: ControlInput,
    active: InputActive,
    heading: number,
  ): void;
  /** Record one chassis contact impact for `step`. No-op unless recording. */
  recordImpact(step: number, point: { x: number; y: number; z: number }, magnitude: number): void;
  /** Lightweight snapshot for the HUD. */
  summary(): TelemetrySummary;
  /** Serialize the capture to a CSV string (metadata header + one row per step). */
  buildCsv(): string;
  /**
   * Snapshot the most recent capture as a {@link ReplayCapture} for the 3D
   * replay player, or `null` if nothing has been recorded. Deep-copies the
   * visual frames so the returned capture is independent of any later
   * {@link start} (which clears the recorder).
   */
  getReplay(): ReplayCapture | null;
};

/**
 * Safety cap on rows held in memory (30 min at 60 Hz). Recording auto-stops
 * here so a forgotten capture can't grow without bound. Never hit in a real
 * race, which is minutes not half-hours.
 */
const MAX_STEPS = 60 * 60 * 30;

export function createTelemetryRecorder(meta: TelemetryMeta): TelemetryRecorder {
  const steps: TelemetryStep[] = [];
  const hits = new Map<number, StepHits>();
  let recording = false;
  let recordedAt = '';

  const reset = (): void => {
    steps.length = 0;
    hits.clear();
  };

  return {
    get recording(): boolean {
      return recording;
    },
    get frameCount(): number {
      return steps.length;
    },
    start(): void {
      reset();
      recordedAt = new Date().toISOString();
      recording = true;
    },
    stop(): void {
      recording = false;
    },
    recordStep(step, snapshot, input, active, heading): void {
      if (!recording) return;
      if (steps.length >= MAX_STEPS) {
        recording = false;
        return;
      }
      steps.push({
        step,
        position: { x: snapshot.position.x, y: snapshot.position.y, z: snapshot.position.z },
        rotation: {
          x: snapshot.rotation.x,
          y: snapshot.rotation.y,
          z: snapshot.rotation.z,
          w: snapshot.rotation.w,
        },
        speed: snapshot.speed,
        heading,
        throttle: input.throttle,
        brake: input.brake,
        steering: input.steering,
        handbrake: input.handbrake,
        reset: input.reset,
        up: active.up,
        down: active.down,
        arrowLeft: active.arrowLeft,
        arrowRight: active.arrowRight,
        // Visual subset of each wheel for the replay player (drops the slip /
        // contact-point fields the live skid FX needs but a replay doesn't).
        wheels: snapshot.wheels.map((w) => ({
          position: { x: w.position.x, y: w.position.y, z: w.position.z },
          steering: w.steering,
          rotation: w.rotation,
          inContact: w.inContact,
        })),
      });
    },
    recordImpact(step, point, magnitude): void {
      if (!recording) return;
      const existing = hits.get(step);
      if (!existing) {
        hits.set(step, { count: 1, maxMagnitude: magnitude, point: { x: point.x, y: point.y, z: point.z } });
        return;
      }
      existing.count += 1;
      if (magnitude > existing.maxMagnitude) {
        existing.maxMagnitude = magnitude;
        existing.point.x = point.x;
        existing.point.y = point.y;
        existing.point.z = point.z;
      }
    },
    summary(): TelemetrySummary {
      let hitCount = 0;
      for (const h of hits.values()) hitCount += h.count;
      return {
        recording,
        frameCount: steps.length,
        hitCount,
        durationS: steps.length * FIXED_DT,
      };
    },
    getReplay(): ReplayCapture | null {
      if (steps.length === 0) return null;
      // Deep-copy the visual subset so the capture outlives any later start()
      // (which clears `steps`). One allocation per replay-enter — fine for dev.
      const frames: ReplayFrame[] = steps.map((s) => ({
        position: { x: s.position.x, y: s.position.y, z: s.position.z },
        rotation: { x: s.rotation.x, y: s.rotation.y, z: s.rotation.z, w: s.rotation.w },
        speed: s.speed,
        wheels: s.wheels.map((w) => ({
          position: { x: w.position.x, y: w.position.y, z: w.position.z },
          steering: w.steering,
          rotation: w.rotation,
          inContact: w.inContact,
        })),
      }));
      return { meta, fixedDt: FIXED_DT, frames };
    },
    buildCsv(): string {
      const lines: string[] = [];
      // Metadata header — `#`-commented so a replay loader can read it and a CSV
      // reader can skip it. Holds everything needed to reconstruct the session.
      // v2 adds the arrow_up/down/left/right columns (bike lean + steer keys).
      lines.push('# rTracer telemetry v2');
      lines.push(`# recorded_at=${recordedAt}`);
      lines.push(`# zone=${meta.zoneId} zone_version=${meta.zoneVersion}`);
      lines.push(`# vehicle=${meta.vehicleId} vehicle_version=${meta.vehicleVersion}`);
      lines.push(`# fixed_dt=${FIXED_DT}`);
      lines.push(`# spawn_pos=${meta.spawn.position.join(',')}`);
      lines.push(`# spawn_rot=${meta.spawn.rotation.join(',')}`);
      lines.push(`# frames=${steps.length}`);
      lines.push(
        [
          'step',
          'time_s',
          'pos_x',
          'pos_y',
          'pos_z',
          'quat_x',
          'quat_y',
          'quat_z',
          'quat_w',
          'speed_ms',
          'speed_kmh',
          'heading_deg',
          'throttle',
          'brake',
          'steering',
          'handbrake',
          'reset',
          'arrow_up',
          'arrow_down',
          'arrow_left',
          'arrow_right',
          'hit_count',
          'hit_mag',
          'hit_x',
          'hit_y',
          'hit_z',
        ].join(','),
      );

      for (const s of steps) {
        const hit = hits.get(s.step);
        lines.push(
          [
            s.step,
            (s.step * FIXED_DT).toFixed(4),
            num(s.position.x),
            num(s.position.y),
            num(s.position.z),
            num(s.rotation.x),
            num(s.rotation.y),
            num(s.rotation.z),
            num(s.rotation.w),
            num(s.speed),
            num(s.speed * 3.6),
            num(s.heading),
            num(s.throttle),
            num(s.brake),
            num(s.steering),
            num(s.handbrake),
            s.reset ? 1 : 0,
            s.up ? 1 : 0,
            s.down ? 1 : 0,
            s.arrowLeft ? 1 : 0,
            s.arrowRight ? 1 : 0,
            hit ? hit.count : 0,
            hit ? num(hit.maxMagnitude) : '',
            hit ? num(hit.point.x) : '',
            hit ? num(hit.point.y) : '',
            hit ? num(hit.point.z) : '',
          ].join(','),
        );
      }

      return lines.join('\n');
    },
  };
}

/** Compact fixed-precision number for CSV cells (trims float noise). */
function num(v: number): string {
  return Number.isFinite(v) ? v.toFixed(4) : '';
}
