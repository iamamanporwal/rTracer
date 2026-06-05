import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Pause,
  Play,
  Car,
  Map as MapIcon,
  RotateCcw,
  Camera,
  CloudSun,
  Maximize,
  Minimize,
  X,
} from 'lucide-react';
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  useFullscreen,
} from '~/lib/use-device';
import type { ZoneSession } from './session';

/**
 * Pause / menu surface for touch play. A single pause chip sits top-left
 * (inside the safe area); tapping it freezes the session and opens a full-bleed
 * menu. The menu is the only way to reach the camera, weather, fullscreen, and
 * reset verbs that desktop drives from the keyboard, plus the requested
 * "change car / change map" exits.
 *
 * Pausing routes through {@link ZoneSession.pause} (loop + audio stop); resuming
 * or dismissing the backdrop calls {@link ZoneSession.resume}. Navigating to the
 * garage or track picker simply unmounts `Play`, which disposes the session — no
 * resume needed.
 */
export function PauseMenu({
  session,
  cameraLabel,
  weatherLabel,
  zoneName,
  vehicleName,
}: {
  session: ZoneSession | null;
  cameraLabel: string;
  weatherLabel: string;
  zoneName: string;
  vehicleName: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const fullscreen = useFullscreen();

  const openMenu = (): void => {
    session?.pause();
    setOpen(true);
  };
  const closeMenu = (): void => {
    setOpen(false);
    session?.resume();
  };

  return (
    <>
      {/* Pause chip — top-left, clear of the notch. */}
      <button
        type="button"
        aria-label="Pause"
        onClick={openMenu}
        style={{
          top: 'max(env(safe-area-inset-top), 0.75rem)',
          left: 'max(env(safe-area-inset-left), 0.75rem)',
        }}
        className="absolute z-30 grid h-11 w-11 touch-none place-items-center rounded-full border border-white/25 bg-black/40 text-white/90 backdrop-blur-md active:scale-95"
      >
        <Pause size={20} strokeWidth={2.5} />
      </button>

      {!open ? null : (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/80 p-6 backdrop-blur-md"
          onClick={closeMenu}
        >
          {/* Stop backdrop clicks inside the panel from closing the menu. */}
          <div
            className="mw-fade w-full max-w-sm -skew-x-3 border border-mw-edge/60 bg-mw-panel/90 p-6 shadow-[0_0_60px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="skew-x-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-mw-accent">
                    Paused
                  </div>
                  <h2 className="mt-1 font-display text-3xl font-bold uppercase leading-none tracking-tight text-mw-text">
                    {zoneName}
                  </h2>
                  <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.25em] text-mw-muted">
                    {vehicleName}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Resume"
                  onClick={closeMenu}
                  className="grid h-9 w-9 place-items-center rounded-full border border-mw-edge/60 text-mw-muted active:scale-95"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="mt-6 space-y-2.5">
                <Item icon={<Play size={18} />} label="Resume" onClick={closeMenu} primary />
                <Item
                  icon={<RotateCcw size={18} />}
                  label="Reset Car"
                  onClick={() => {
                    session?.resetVehicle();
                    closeMenu();
                  }}
                />
                <Item
                  icon={<Camera size={18} />}
                  label="Camera"
                  value={cameraLabel}
                  onClick={() => session?.cycleCamera()}
                />
                <Item
                  icon={<CloudSun size={18} />}
                  label="Weather"
                  value={weatherLabel}
                  onClick={() => session?.cycleWeather()}
                />
                {fullscreenSupported() && (
                  <Item
                    icon={fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                    label={fullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    onClick={() => void (fullscreen ? exitFullscreen() : enterFullscreen())}
                  />
                )}
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2.5 border-t border-mw-edge/50 pt-5">
                <Item icon={<Car size={18} />} label="Change Car" onClick={() => void navigate({ to: '/' })} />
                <Item
                  icon={<MapIcon size={18} />}
                  label="Change Map"
                  onClick={() => void navigate({ to: '/maps' })}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Item({
  icon,
  label,
  value,
  onClick,
  primary = false,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full touch-none items-center gap-3 px-4 py-3 text-left font-display text-sm font-semibold uppercase tracking-[0.15em] transition-colors active:scale-[0.98] ' +
        (primary
          ? 'bg-mw-accent text-mw-bg'
          : 'border border-mw-edge/60 bg-mw-steel/40 text-mw-text hover:border-mw-accent/60')
      }
    >
      <span className={primary ? 'text-mw-bg' : 'text-mw-accent'}>{icon}</span>
      <span className="flex-1">{label}</span>
      {value && (
        <span className="font-mono text-[11px] normal-case tracking-normal text-mw-muted">
          {value}
        </span>
      )}
    </button>
  );
}
