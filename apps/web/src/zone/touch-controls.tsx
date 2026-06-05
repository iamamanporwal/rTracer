import { useState, type PointerEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ChevronsUp, Square } from 'lucide-react';
import type { ZoneSession } from './session';

/**
 * Transparent on-screen driving pad for touch devices.
 *
 *   - bottom-left  · steer left / steer right
 *   - bottom-right · brake / accelerate
 *   - bottom-centre· handbrake (drift), the gameplay verb desktop gets on Space
 *
 * The container is `pointer-events-none` so the gaps between clusters stay
 * transparent to the canvas drag-look camera; only the buttons themselves
 * capture pointers. Each button fires on `pointerdown` (zero latency) and
 * captures the pointer so a finger sliding past the edge still releases cleanly
 * on `pointerup`. Sizes are `clamp()`-based so the pad scales from a small phone
 * to a tablet without media-query thrash. Inputs flow straight into the running
 * session's {@link ZoneSession.touch} surface — the React tree never re-renders
 * per press (the held state lives in the input driver, not in component state).
 */
export function TouchControls({ session }: { session: ZoneSession | null }) {
  const t = session?.touch ?? null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-20 select-none"
      // Sit the controls inside the notch / home-indicator safe areas.
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Steering — bottom-left */}
      <div className="pointer-events-auto absolute bottom-0 left-0 flex items-end gap-3 p-4 sm:gap-4 sm:p-6">
        <HoldButton
          ariaLabel="Steer left"
          onPress={() => t?.setSteer(-1)}
          onRelease={() => t?.setSteer(0)}
        >
          <ChevronLeft className="h-1/2 w-1/2" strokeWidth={2.5} />
        </HoldButton>
        <HoldButton
          ariaLabel="Steer right"
          onPress={() => t?.setSteer(1)}
          onRelease={() => t?.setSteer(0)}
        >
          <ChevronRight className="h-1/2 w-1/2" strokeWidth={2.5} />
        </HoldButton>
      </div>

      {/* Handbrake / drift — bottom-centre, smaller and secondary */}
      <div className="pointer-events-auto absolute bottom-0 left-1/2 flex -translate-x-1/2 items-end p-4 sm:p-6">
        <HoldButton
          ariaLabel="Handbrake"
          small
          onPress={() => t?.setHandbrake(true)}
          onRelease={() => t?.setHandbrake(false)}
        >
          <span className="font-display text-xs font-semibold uppercase tracking-widest">Drift</span>
        </HoldButton>
      </div>

      {/* Pedals — bottom-right (brake left of accel, gas under the thumb) */}
      <div className="pointer-events-auto absolute bottom-0 right-0 flex items-end gap-3 p-4 sm:gap-4 sm:p-6">
        <HoldButton
          ariaLabel="Brake"
          tone="brake"
          onPress={() => t?.setBrake(true)}
          onRelease={() => t?.setBrake(false)}
        >
          <Square className="h-2/5 w-2/5" strokeWidth={2.5} fill="currentColor" />
        </HoldButton>
        <HoldButton
          ariaLabel="Accelerate"
          tone="accel"
          onPress={() => t?.setThrottle(true)}
          onRelease={() => t?.setThrottle(false)}
        >
          <ChevronsUp className="h-1/2 w-1/2" strokeWidth={2.5} />
        </HoldButton>
      </div>
    </div>
  );
}

type Tone = 'neutral' | 'accel' | 'brake';

const TONE_RING: Record<Tone, string> = {
  neutral: 'border-white/30 text-white/85 active:bg-white/20',
  accel: 'border-emerald-300/50 text-emerald-100 active:bg-emerald-400/30',
  brake: 'border-rose-300/50 text-rose-100 active:bg-rose-400/30',
};

function HoldButton({
  ariaLabel,
  onPress,
  onRelease,
  children,
  tone = 'neutral',
  small = false,
}: {
  ariaLabel: string;
  onPress: () => void;
  onRelease: () => void;
  children: ReactNode;
  tone?: Tone;
  small?: boolean;
}) {
  // Track active purely for the visual press state; the *control* signal is
  // pushed imperatively in onPress/onRelease so a held press never depends on a
  // React render landing in time.
  const [active, setActive] = useState(false);

  const press = (e: PointerEvent<HTMLButtonElement>): void => {
    // Keep receiving move/up even if the finger drifts off the button.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setActive(true);
    onPress();
  };
  const release = (): void => {
    setActive(false);
    onRelease();
  };

  const size = small
    ? 'h-[clamp(3rem,9vw,4rem)] w-[clamp(4.5rem,16vw,6.5rem)] rounded-2xl'
    : 'h-[clamp(4.5rem,15vw,7rem)] w-[clamp(4.5rem,15vw,7rem)] rounded-3xl';

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      className={
        'grid touch-none place-items-center border bg-black/25 backdrop-blur-md transition-transform duration-75 ' +
        'shadow-[0_2px_18px_rgba(0,0,0,0.45)] ' +
        size +
        ' ' +
        TONE_RING[tone] +
        (active ? ' scale-95' : '')
      }
    >
      {children}
    </button>
  );
}
