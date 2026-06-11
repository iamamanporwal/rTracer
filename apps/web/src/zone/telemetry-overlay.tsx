import { Circle, Download, Play, Square } from 'lucide-react';
import type { InputActive } from './input';
import type { TelemetrySummary } from './telemetry';

/**
 * Dev-mode telemetry overlay — bottom-left of the play view, gated behind dev
 * mode by the caller. A single bottom-left column stacks:
 *
 *   - {@link TelemetryPanel} — start/stop a race capture, watch the 3D replay,
 *     and download it as CSV.
 *   - {@link InputLogger}    — live WASD + Space + arrow keycaps, lit while held.
 *
 * Pure presentational: input + telemetry state flow in via {@link SessionStats}
 * (refreshed each frame) and actions flow out through the session methods the
 * caller wires up. The whole column is anchored once so the two cards can't
 * overlap as either grows.
 */
export function TelemetryOverlay({
  input,
  telemetry,
  isTouch,
  onStart,
  onStop,
  onDownload,
  onPlay,
}: {
  input: InputActive;
  telemetry: TelemetrySummary;
  isTouch: boolean;
  onStart: () => void;
  onStop: () => void;
  onDownload: () => void;
  /** Open the 3D replay player for the last capture. */
  onPlay: () => void;
}) {
  return (
    <div
      className="absolute z-20 flex flex-col items-start gap-3"
      style={{
        left: 'max(env(safe-area-inset-left), 0.75rem)',
        // On touch the steering pad owns the corner, so lift the stack above it.
        bottom: isTouch
          ? 'calc(max(env(safe-area-inset-bottom), 0.75rem) + 8rem)'
          : 'max(env(safe-area-inset-bottom), 0.75rem)',
      }}
    >
      <TelemetryPanel
        telemetry={telemetry}
        onStart={onStart}
        onStop={onStop}
        onDownload={onDownload}
        onPlay={onPlay}
      />
      <InputLogger input={input} />
    </div>
  );
}

function Keycap({ label, active, wide }: { label: string; active: boolean; wide?: boolean }) {
  return (
    <div
      className={[
        'grid place-items-center rounded-md border font-mono text-xs font-semibold transition-colors duration-75',
        wide ? 'h-8 w-[7.25rem]' : 'h-8 w-8',
        active
          ? 'border-trace-accent bg-trace-accent text-black'
          : 'border-trace-line bg-black/55 text-trace-muted',
      ].join(' ')}
    >
      {label}
    </div>
  );
}

/** Real-time keyboard input logger — the WASD + Space cluster (drive intents,
 * keyboard or touch) beside the arrow cluster (bike lean ↑/↓ + steer ←/→, shown
 * per the literal key so each arrow lights on its own). */
function InputLogger({ input }: { input: InputActive }) {
  return (
    <div className="flex items-start gap-3 backdrop-blur">
      <div className="flex flex-col items-center gap-1">
        <Keycap label="W" active={input.throttle} />
        <div className="flex gap-1">
          <Keycap label="A" active={input.left} />
          <Keycap label="S" active={input.brake} />
          <Keycap label="D" active={input.right} />
        </div>
        <Keycap label="SPACE" active={input.handbrake} wide />
      </div>
      <div className="flex flex-col items-center gap-1">
        <Keycap label="↑" active={input.up} />
        <div className="flex gap-1">
          <Keycap label="←" active={input.arrowLeft} />
          <Keycap label="↓" active={input.down} />
          <Keycap label="→" active={input.arrowRight} />
        </div>
      </div>
    </div>
  );
}

/** Telemetry capture controls — record toggle + CSV download, with a live
 * status line (duration / frames / hits). */
function TelemetryPanel({
  telemetry,
  onStart,
  onStop,
  onDownload,
  onPlay,
}: {
  telemetry: TelemetrySummary;
  onStart: () => void;
  onStop: () => void;
  onDownload: () => void;
  onPlay: () => void;
}) {
  const { recording, frameCount, hitCount, durationS } = telemetry;
  // A finished, non-empty capture can be replayed in 3D or downloaded as CSV.
  const hasCapture = !recording && frameCount > 0;

  return (
    <div className="w-44 rounded-md border border-trace-line bg-black/55 p-2.5 backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider">
        <span className="text-trace-accent">Telemetry</span>
        {recording ? (
          <span className="flex items-center gap-1 text-red-400">
            <Circle size={8} className="animate-pulse fill-current" /> REC
          </span>
        ) : (
          <span className="text-trace-muted">idle</span>
        )}
      </div>

      <div className="mb-2 font-mono text-[11px] leading-snug text-trace-muted">
        <div>
          {durationS.toFixed(1)}s · {frameCount} frames
        </div>
        <div>
          {hitCount} hit{hitCount === 1 ? '' : 's'}
        </div>
      </div>

      <div className="flex gap-1.5">
        {recording ? (
          <button
            type="button"
            onClick={onStop}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-red-500/60 bg-red-500/15 px-2 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/25"
          >
            <Square size={12} className="fill-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-trace-line bg-white/5 px-2 py-1.5 text-xs font-medium text-trace-fg hover:bg-white/10"
          >
            <Circle size={12} className="fill-red-500 text-red-500" /> Record
          </button>
        )}
        <button
          type="button"
          onClick={onPlay}
          disabled={!hasCapture}
          aria-label="Watch 3D replay"
          title="Watch 3D replay"
          className="flex items-center justify-center rounded border border-trace-line bg-white/5 px-2.5 py-1.5 text-trace-fg hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Play size={14} className="fill-current" />
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={!hasCapture}
          aria-label="Download telemetry CSV"
          title="Download telemetry CSV"
          className="flex items-center justify-center rounded border border-trace-line bg-white/5 px-2.5 py-1.5 text-trace-fg hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Download size={14} />
        </button>
      </div>
    </div>
  );
}
