import { useCallback, useState, type ReactNode } from 'react';
import { RotateCw, Play } from 'lucide-react';
import {
  enterFullscreen,
  fullscreenSupported,
  lockLandscape,
  useIsTouch,
  usePortrait,
} from './use-device';

/**
 * Mobile entry shell. On touch devices it wraps the whole app with two gates:
 *
 *   1. A one-time "tap to start" launch screen. The tap is the user gesture the
 *      browser requires to enter fullscreen + lock landscape (Android), and it
 *      doubles as the autoplay-unlock gesture. Persisted in `sessionStorage` so
 *      route changes don't re-prompt.
 *   2. A "rotate to landscape" overlay whenever the device is held in portrait —
 *      a racing game wants the wide axis.
 *
 * On desktop (and the Playwright `Desktop Chrome` E2E project, which is not a
 * touch device) this renders `children` untouched — no gate, no overlay.
 */

const STARTED_KEY = 'trace.started';

function readStarted(): boolean {
  try {
    return sessionStorage.getItem(STARTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function MobileShell({ children }: { children: ReactNode }) {
  const isTouch = useIsTouch();
  const portrait = usePortrait();
  const [started, setStarted] = useState(readStarted);

  const start = useCallback((): void => {
    setStarted(true);
    try {
      sessionStorage.setItem(STARTED_KEY, '1');
    } catch {
      // private mode / storage disabled — fine, we just re-prompt next load
    }
    if (fullscreenSupported()) void enterFullscreen();
    void lockLandscape();
  }, []);

  return (
    <>
      {children}
      {isTouch && !started && <LaunchGate onStart={start} />}
      {isTouch && portrait && <RotatePrompt />}
    </>
  );
}

function LaunchGate({ onStart }: { onStart: () => void }) {
  return (
    <button
      type="button"
      onClick={onStart}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 bg-mw-bg text-mw-text"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(54,166,255,0.18),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.85))]" />
      <div className="relative text-center">
        <div className="font-mono text-xs uppercase tracking-[0.5em] text-mw-accent">Trace</div>
        <h1 className="mt-2 font-display text-6xl font-bold uppercase tracking-tight text-mw-text">
          Drive
        </h1>
      </div>
      <div className="relative flex items-center gap-3 -skew-x-12 bg-mw-accent px-8 py-3.5 shadow-[0_0_34px_rgba(54,166,255,0.45)]">
        <Play className="skew-x-12 text-mw-bg" size={22} strokeWidth={3} fill="currentColor" />
        <span className="skew-x-12 font-display text-xl font-bold uppercase tracking-[0.2em] text-mw-bg">
          Tap to start
        </span>
      </div>
      <div className="relative font-mono text-[11px] uppercase tracking-[0.3em] text-mw-muted">
        Fullscreen · landscape
      </div>
    </button>
  );
}

function RotatePrompt() {
  return (
    <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-mw-bg/95 text-center backdrop-blur-md">
      <RotateCw className="animate-pulse text-mw-accent" size={56} strokeWidth={1.5} />
      <div>
        <div className="font-display text-2xl font-bold uppercase tracking-wide text-mw-text">
          Rotate your device
        </div>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.3em] text-mw-muted">
          Trace plays in landscape
        </p>
      </div>
    </div>
  );
}
