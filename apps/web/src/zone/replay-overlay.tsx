import type { ReactNode } from 'react';
import { Eye, EyeOff, Pause, Play, Rewind, RotateCcw, X } from 'lucide-react';
import type { ReplayHandle, ReplayState } from './session';
import { REPLAY_SPEEDS } from './replay';

/**
 * Dev 3D-replay transport — a video-player chrome over the live canvas while the
 * session is in replay mode. The canvas itself shows the recorded run (the
 * session poses the car from telemetry frames and drives a free bird's-eye
 * camera); this overlay only renders the scrubber + controls and forwards every
 * action to the {@link ReplayHandle}. State arrives via {@link ReplayState},
 * refreshed each frame by the session.
 *
 * Camera navigation (orbit / zoom / pan) is mouse + touch on the canvas, handled
 * by the session's replay camera — the hint chip spells it out.
 */
export function ReplayOverlay({
  state,
  handle,
  onExit,
}: {
  state: ReplayState;
  handle: ReplayHandle;
  onExit: () => void;
}) {
  const frac = state.durationS > 0 ? state.timeS / state.durationS : 0;

  const cycleSpeed = (): void => {
    const i = REPLAY_SPEEDS.indexOf(state.speed as (typeof REPLAY_SPEEDS)[number]);
    const next = REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length]!;
    handle.setSpeed(next);
  };

  return (
    <>
      {/* Navigation hint — top-center. */}
      <div
        className="pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 rounded-full border border-trace-line bg-black/55 px-3 py-1 text-[11px] text-trace-muted backdrop-blur"
        style={{ top: 'max(env(safe-area-inset-top), 0.75rem)' }}
      >
        <span className="text-trace-accent">Replay</span> · drag to orbit · scroll to zoom ·
        right-drag / two-finger to pan
      </div>

      {/* Transport bar — bottom, full width. */}
      <div
        className="absolute inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-trace-line bg-black/70 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: 'calc(max(env(safe-area-inset-bottom), 0.75rem))' }}
      >
        {/* Scrubber. */}
        <div className="flex items-center gap-3 font-mono text-[11px] text-trace-muted">
          <span className="w-12 text-right tabular-nums">{state.timeS.toFixed(1)}s</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={frac}
            aria-label="Replay timeline"
            onPointerDown={() => handle.pause()}
            onChange={(e) => handle.seekFrac(Number(e.target.value))}
            className="trace-scrub h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-trace-line accent-trace-accent"
          />
          <span className="w-12 tabular-nums">{state.durationS.toFixed(1)}s</span>
        </div>

        {/* Controls. */}
        <div className="flex items-center justify-center gap-2 pb-1">
          <TransportButton label="Restart" onClick={() => handle.restart()}>
            <RotateCcw size={18} />
          </TransportButton>
          <TransportButton
            label="Reverse"
            active={state.playing && state.reversed}
            onClick={() => handle.reverse()}
          >
            <Rewind size={18} className="fill-current" />
          </TransportButton>
          <TransportButton
            label={state.playing ? 'Pause' : 'Play'}
            primary
            onClick={() => (state.playing ? handle.pause() : handle.play())}
          >
            {state.playing ? (
              <Pause size={22} className="fill-current" />
            ) : (
              <Play size={22} className="fill-current" />
            )}
          </TransportButton>
          <button
            type="button"
            onClick={cycleSpeed}
            aria-label="Playback speed"
            className="grid h-10 w-12 place-items-center rounded-md border border-trace-line bg-white/5 font-mono text-xs font-semibold text-trace-fg hover:bg-white/10"
          >
            {state.speed}×
          </button>
          <TransportButton
            label={state.following ? 'Following car' : 'Free camera'}
            active={state.following}
            onClick={() => handle.setFollow(!state.following)}
          >
            {state.following ? <Eye size={18} /> : <EyeOff size={18} />}
          </TransportButton>

          <div className="mx-1 h-7 w-px bg-trace-line" />

          <TransportButton label="Exit replay" onClick={onExit}>
            <X size={18} />
          </TransportButton>
        </div>
      </div>
    </>
  );
}

function TransportButton({
  children,
  label,
  onClick,
  primary = false,
  active = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  active?: boolean;
}) {
  const skin = primary
    ? 'bg-trace-accent text-black hover:bg-trace-accent/90'
    : active
      ? 'border border-trace-accent bg-trace-accent/15 text-trace-accent'
      : 'border border-trace-line bg-white/5 text-trace-fg hover:bg-white/10';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid h-10 w-10 touch-none place-items-center rounded-md transition-colors active:scale-95 ${skin}`}
    >
      {children}
    </button>
  );
}
