import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Flag,
  FlagTriangleRight,
  Crosshair,
  Car,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Repeat,
  ArrowRight,
  Minus,
  Plus,
} from 'lucide-react';
import type { RaceControls, RaceState } from './session';

/**
 * Dev-Mode Race Builder HUD — top-right while dev mode is on.
 *
 * A self-contained authoring + timing surface: pick a track type, drop the
 * flame gates (at the car, or by clicking the ground), and run a 3-2-1 standing
 * start with a live stopwatch. All state comes from the session's per-frame
 * {@link RaceState}; every button calls back through {@link RaceControls}. The
 * 3-2-1 / GO! countdown renders as a centre-screen overlay.
 */
export function RaceHud({
  state,
  controls,
  isTouch,
}: {
  state: RaceState | null;
  controls: RaceControls;
  isTouch: boolean;
}) {
  if (!state) return null;

  const { trackType, phase, hasStart, hasFinish, placing } = state;
  const racing = phase === 'running' || phase === 'countdown';
  const canStart = hasStart && (trackType === 'loop' || hasFinish);

  // Which time the big readout shows: live while timing, else the last result.
  const shownMs =
    phase === 'running' || phase === 'countdown'
      ? state.elapsedMs
      : phase === 'finished'
        ? state.lastMs
        : 0;
  const newBest = phase === 'finished' && state.lastMs != null && state.lastMs === state.bestMs;

  return (
    <>
      <Countdown phase={phase} countdownMs={state.countdownMs} />

      <div
        className="absolute z-30 w-[16rem] -skew-x-3 border border-mw-edge/60 bg-mw-panel/92 shadow-[0_0_40px_rgba(0,0,0,0.55)] backdrop-blur-md"
        style={{
          top: isTouch ? 'calc(max(env(safe-area-inset-top), 0.5rem) + 8rem)' : 'max(env(safe-area-inset-top), 0.75rem)',
          right: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        <div className="skew-x-3 p-3.5">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.35em] text-mw-accent">
              Race Builder
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-mw-muted">
              {phase}
            </span>
          </div>

          {/* Stopwatch */}
          <div className="mt-2 rounded border border-mw-edge/50 bg-mw-bg/60 px-3 py-2 text-center">
            <div
              className={
                'font-display text-4xl font-bold tabular-nums leading-none ' +
                (newBest ? 'text-mw-accent' : 'text-mw-text')
              }
            >
              {fmt(shownMs)}
            </div>
            <div className="mt-1 flex items-center justify-center gap-3 font-mono text-[10px] text-mw-muted">
              <span>LAST {fmt(state.lastMs)}</span>
              <span className="text-mw-accent/80">BEST {fmt(state.bestMs)}</span>
            </div>
            {trackType === 'loop' && racing && (
              <div className="mt-0.5 font-mono text-[10px] text-mw-muted">
                LAP {Math.min(state.lap + 1, state.totalLaps)} / {state.totalLaps}
              </div>
            )}
            {newBest && (
              <div className="mt-0.5 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-mw-accent">
                New Best!
              </div>
            )}
          </div>

          {/* Track type */}
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <Chip
              active={trackType === 'loop'}
              disabled={racing}
              onClick={() => controls.setTrackType('loop')}
              icon={<Repeat size={13} />}
            >
              Loop
            </Chip>
            <Chip
              active={trackType === 'sprint'}
              disabled={racing}
              onClick={() => controls.setTrackType('sprint')}
              icon={<ArrowRight size={13} />}
            >
              Sprint
            </Chip>
          </div>

          {/* Gate placement */}
          <div className="mt-3 space-y-2">
            <GateRow
              label="Start"
              icon={<Flag size={13} />}
              dotClass="bg-[#39ff88]"
              placed={hasStart}
              placing={placing === 'start'}
              disabled={racing}
              onCar={() => controls.placeAtCar('start')}
              onPlace={() => (placing === 'start' ? controls.cancelPlacement() : controls.beginPlacement('start'))}
            />
            {trackType === 'sprint' && (
              <GateRow
                label="Finish"
                icon={<FlagTriangleRight size={13} />}
                dotClass="bg-[#ff3b2f]"
                placed={hasFinish}
                placing={placing === 'finish'}
                disabled={racing}
                onCar={() => controls.placeAtCar('finish')}
                onPlace={() => (placing === 'finish' ? controls.cancelPlacement() : controls.beginPlacement('finish'))}
              />
            )}
            {trackType === 'loop' && (
              <div className="flex items-center justify-between rounded border border-mw-edge/50 bg-mw-steel/30 px-2.5 py-1.5">
                <span className="font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-mw-text">
                  Laps
                </span>
                <div className="flex items-center gap-2">
                  <Stepper aria-label="Fewer laps" disabled={racing} onClick={() => controls.setLaps(state.totalLaps - 1)}>
                    <Minus size={12} />
                  </Stepper>
                  <span className="w-5 text-center font-mono text-sm text-mw-text">{state.totalLaps}</span>
                  <Stepper aria-label="More laps" disabled={racing} onClick={() => controls.setLaps(state.totalLaps + 1)}>
                    <Plus size={12} />
                  </Stepper>
                </div>
              </div>
            )}
          </div>

          {/* Placement banner */}
          {placing && (
            <div className="mt-3 rounded border border-mw-accent/60 bg-mw-accent/10 px-2.5 py-2">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-mw-accent">
                <Crosshair size={12} /> Click ground to place {placing}
              </div>
              <button
                type="button"
                onClick={() => controls.cancelPlacement()}
                className="mt-1.5 w-full rounded border border-mw-edge/60 bg-mw-steel/50 py-1 font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-mw-text active:scale-[0.98]"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Controls */}
          <div className="mt-3 space-y-1.5">
            {racing ? (
              <BigBtn onClick={() => controls.stopRace()} tone="hot" icon={<Square size={15} />}>
                Stop
              </BigBtn>
            ) : (
              <BigBtn onClick={() => controls.startRace()} disabled={!canStart} tone="accent" icon={<Play size={15} />}>
                Start Race
              </BigBtn>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <SmallBtn onClick={() => controls.resetRace()} disabled={!hasStart} icon={<RotateCcw size={13} />}>
                Reset
              </SmallBtn>
              <SmallBtn onClick={() => controls.clear()} disabled={!hasStart && !hasFinish} icon={<Trash2 size={13} />}>
                Clear
              </SmallBtn>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Centre-screen 3-2-1 / GO! overlay, driven by the race phase. */
function Countdown({ phase, countdownMs }: { phase: RaceState['phase']; countdownMs: number }) {
  const [go, setGo] = useState(false);
  const prev = useRef(phase);
  useEffect(() => {
    if (prev.current === 'countdown' && phase === 'running') {
      setGo(true);
      const id = setTimeout(() => setGo(false), 650);
      prev.current = phase;
      return () => clearTimeout(id);
    }
    prev.current = phase;
    return undefined;
  }, [phase]);

  if (phase !== 'countdown' && !go) return null;
  const text = phase === 'countdown' ? String(Math.max(1, Math.ceil(countdownMs / 1000))) : 'GO!';
  return (
    <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center">
      <div
        key={text}
        className={
          'mw-pop font-display font-bold uppercase leading-none [text-shadow:0_4px_30px_rgba(0,0,0,0.8)] ' +
          (text === 'GO!' ? 'text-7xl text-mw-accent' : 'text-8xl text-mw-text')
        }
      >
        {text}
      </div>
    </div>
  );
}

// ── Presentational helpers (match the pause-menu's mw look) ───────────────────

function GateRow({
  label,
  icon,
  dotClass,
  placed,
  placing,
  disabled,
  onCar,
  onPlace,
}: {
  label: string;
  icon: ReactNode;
  dotClass: string;
  placed: boolean;
  placing: boolean;
  disabled: boolean;
  onCar: () => void;
  onPlace: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={'h-2 w-2 shrink-0 rounded-full ' + (placed ? dotClass : 'bg-mw-edge')} />
      <span className="flex w-14 items-center gap-1 font-display text-[11px] font-semibold uppercase tracking-[0.1em] text-mw-text">
        {icon}
        {label}
      </span>
      <SmallBtn onClick={onCar} disabled={disabled} icon={<Car size={12} />}>
        @ Car
      </SmallBtn>
      <SmallBtn onClick={onPlace} disabled={disabled} active={placing} icon={<Crosshair size={12} />}>
        Place
      </SmallBtn>
    </div>
  );
}

function Chip({
  active,
  disabled,
  onClick,
  icon,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex items-center justify-center gap-1 rounded px-2 py-1.5 font-display text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors active:scale-[0.98] disabled:opacity-40 ' +
        (active
          ? 'border border-mw-accent bg-mw-accent/20 text-mw-text'
          : 'border border-mw-edge/60 bg-mw-steel/40 text-mw-muted hover:border-mw-accent/60 hover:text-mw-text')
      }
    >
      {icon}
      {children}
    </button>
  );
}

function SmallBtn({
  onClick,
  disabled,
  active,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors active:scale-[0.97] disabled:opacity-40 ' +
        (active
          ? 'border border-mw-accent bg-mw-accent/20 text-mw-text'
          : 'border border-mw-edge/60 bg-mw-steel/40 text-mw-muted hover:border-mw-accent/60 hover:text-mw-text')
      }
    >
      {icon}
      {children}
    </button>
  );
}

function Stepper({
  onClick,
  disabled,
  children,
  ...rest
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
} & { 'aria-label'?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="grid h-6 w-6 place-items-center rounded border border-mw-edge/60 bg-mw-steel/40 text-mw-text transition-colors hover:border-mw-accent/60 active:scale-95 disabled:opacity-40"
      {...rest}
    >
      {children}
    </button>
  );
}

function BigBtn({
  onClick,
  disabled,
  tone,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone: 'accent' | 'hot';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const skin = disabled
    ? 'bg-mw-steel/40 text-mw-muted cursor-not-allowed'
    : tone === 'hot'
      ? 'bg-mw-hot text-white hover:bg-mw-hot/90'
      : 'bg-mw-accent text-mw-bg hover:bg-mw-accent/90';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex w-full items-center justify-center gap-2 rounded py-2 font-display text-sm font-bold uppercase tracking-[0.15em] transition-colors active:scale-[0.99] ' +
        skin
      }
    >
      {icon}
      {children}
    </button>
  );
}

/** ms → `M:SS.cc` (or `S.cc` under a minute); em-dash for null. */
function fmt(ms: number | null): string {
  if (ms == null) return '—';
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const ss = String(s).padStart(2, '0');
  const ccs = String(cs).padStart(2, '0');
  return m > 0 ? `${m}:${ss}.${ccs}` : `${s}.${ccs}`;
}
