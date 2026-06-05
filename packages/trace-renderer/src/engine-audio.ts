import type { VehicleManifest } from '@trace/core';

/**
 * Procedural engine sound (blueprint §15 — audio is synthesized, not sampled,
 * so every car is distinct without shipping audio assets).
 *
 * Two voices share one node graph:
 *   - **combustion** (`v8`/`flat`/`inline`): two detuned sawtooths an octave
 *     apart through a low-pass that opens under load, plus a whiff of noise.
 *     Pitch tracks engine RPM, derived from wheel speed × the selected gear, so
 *     you hear the revs climb and drop on each upshift.
 *   - **electric** (the Hummer EV): a single rising inverter whine — no gears,
 *     pitch tracks road speed — with a faint harmonic and noise floor.
 *
 * The graph is built once; per frame we only nudge `AudioParam`s via
 * `setTargetAtTime`, so there are no clicks and no per-frame allocations. The
 * context starts suspended (autoplay policy); call {@link EngineAudio.resume}
 * from a user gesture.
 */

export type EngineAudio = {
  /** Feed the latest motion each render frame. `speedMs` is unsigned. */
  update(speedMs: number, throttle: number): void;
  /** Resume the audio context (call from a click/keydown). Safe to call often. */
  resume(): void;
  /** Suspend the context — silences the engine while the game is paused. */
  suspend(): void;
  dispose(): void;
};

const NOOP: EngineAudio = {
  update: () => undefined,
  resume: () => undefined,
  suspend: () => undefined,
  dispose: () => undefined,
};
const IDLE_RPM = 800;

type AudioCtor = typeof AudioContext;

export function createEngineAudio(manifest: VehicleManifest): EngineAudio {
  const profile = manifest.audio;
  if (!profile) return NOOP;
  const Ctor: AudioCtor | undefined =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext)
      : undefined;
  if (!Ctor) return NOOP;

  // Capture the profile fields as locals — the flow-narrowing of `profile`
  // above isn't preserved inside the closures below, and primitives sidestep it.
  const kind = profile.kind;
  const idleHz = profile.idleHz;
  const revHz = profile.revHz;
  const isElectric = kind === 'electric';

  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = 0; // ramped up on first resume to avoid a pop
  master.connect(ctx.destination);
  const targetGain = profile.gain ?? 0.4;

  // Shared low-pass that brightens with load.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;
  lp.Q.value = 0.7;
  lp.connect(master);

  // Tonal voices.
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();
  const harm = ctx.createGain();
  harm.gain.value = isElectric ? 0.25 : 0.5;
  if (isElectric) {
    oscA.type = 'triangle';
    oscB.type = 'sine';
  } else {
    oscA.type = 'sawtooth';
    oscB.type = 'sawtooth';
  }
  oscA.frequency.value = idleHz;
  oscB.frequency.value = idleHz * (isElectric ? 2.5 : 0.5);
  oscA.connect(lp);
  oscB.connect(harm);
  harm.connect(lp);

  // Noise texture (combustion grit / inverter hiss).
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noise.connect(noiseGain);
  noiseGain.connect(lp);

  oscA.start();
  oscB.start();
  noise.start();

  // Gearing for the RPM model.
  const radius = manifest.rig.wheels[0]?.radius ?? 0.34;
  const circumference = 2 * Math.PI * radius;
  const ratios = manifest.gearbox.ratios;
  const final = manifest.gearbox.final;
  const redline = manifest.engine.redline;

  let ramped = false;

  function engineRpm(speedMs: number): number {
    const wheelRps = speedMs / circumference;
    if (isElectric || ratios.length <= 1) {
      // Single reduction — pitch just rides road speed.
      return wheelRps * 60 * (ratios[0] ?? 1) * final;
    }
    // Pick the lowest gear that keeps revs under the shift point.
    const shiftRpm = redline * 0.92;
    let rpm = wheelRps * 60 * (ratios[0] ?? 1) * final;
    for (const ratio of ratios) {
      rpm = wheelRps * 60 * ratio * final;
      if (rpm <= shiftRpm) break;
    }
    return rpm;
  }

  function update(speedMs: number, throttle: number): void {
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const t = clamp01(throttle);

    let freq: number;
    let vol: number;
    if (isElectric) {
      const speedN = clamp01(speedMs / 60);
      freq = idleHz + (speedN + t * 0.12) * (revHz - idleHz);
      vol = 0.05 + speedN * 0.55 + t * 0.3;
      setNoise(0.03 + speedN * 0.05);
    } else {
      const rpm = engineRpm(speedMs);
      const rpmN = clamp01((Math.max(rpm, IDLE_RPM + t * 2600) - IDLE_RPM) / (redline - IDLE_RPM));
      freq = idleHz + rpmN * (revHz - idleHz);
      vol = 0.12 + t * 0.5 + rpmN * 0.32;
      setNoise(0.015 + t * 0.05);
      lp.frequency.setTargetAtTime(500 + rpmN * 2600 + t * 1500, now, 0.05);
    }

    oscA.frequency.setTargetAtTime(freq, now, 0.04);
    oscB.frequency.setTargetAtTime(
      freq * (isElectric ? 2.5 : 0.5),
      now,
      0.04,
    );
    master.gain.setTargetAtTime(Math.min(vol, 1) * targetGain, now, 0.06);
  }

  function setNoise(v: number): void {
    noiseGain.gain.setTargetAtTime(v, ctx.currentTime, 0.08);
  }

  function resume(): void {
    if (ctx.state === 'suspended') void ctx.resume();
    if (!ramped) {
      ramped = true;
      master.gain.setTargetAtTime(targetGain * 0.15, ctx.currentTime, 0.3);
    }
  }

  function suspend(): void {
    if (ctx.state === 'running') void ctx.suspend();
  }

  function dispose(): void {
    try {
      oscA.stop();
      oscB.stop();
      noise.stop();
    } catch {
      // already stopped
    }
    void ctx.close();
  }

  return { update, resume, suspend, dispose };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
