import type { ControlInput, VehicleSnapshot } from '@trace/physics';
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
 *   - **Replay** — every row carries BOTH the exact discrete pose (position +
 *     quaternion, for a pose/ghost replay) AND the {@link ControlInput} that was
 *     fed to the controller that step (for a deterministic input replay, which
 *     the fixed-step loop guarantees within a session). A `#`-commented metadata
 *     header (zone, vehicle, spawn, fixed_dt) lets a future loader reconstruct
 *     the session before replaying the rows.
 *
 * Recording is opt-in dev tooling: the session only calls into the recorder
 * while {@link recording} is true, so normal play keeps its zero-allocation hot
 * path. While recording, one small row object is allocated per step — acceptable
 * for a developer capture and never on the default path.
 */

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
  recordStep(step: number, snapshot: VehicleSnapshot, input: ControlInput, heading: number): void;
  /** Record one chassis contact impact for `step`. No-op unless recording. */
  recordImpact(step: number, point: { x: number; y: number; z: number }, magnitude: number): void;
  /** Lightweight snapshot for the HUD. */
  summary(): TelemetrySummary;
  /** Serialize the capture to a CSV string (metadata header + one row per step). */
  buildCsv(): string;
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
    recordStep(step, snapshot, input, heading): void {
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
    buildCsv(): string {
      const lines: string[] = [];
      // Metadata header — `#`-commented so a replay loader can read it and a CSV
      // reader can skip it. Holds everything needed to reconstruct the session.
      lines.push('# rTracer telemetry v1');
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
