import { useEffect, useState } from 'react';

/**
 * Device / viewport / fullscreen primitives for the mobile experience.
 *
 * Everything here is SSR- and test-safe: `window`, `navigator`, `matchMedia`,
 * and the Fullscreen / Screen-Orientation APIs are all feature-detected, so the
 * happy-dom unit environment (which ships none of them) cleanly reports
 * "desktop, no fullscreen" rather than throwing. Desktop browsers and the
 * Playwright `Desktop Chrome` project report `pointer: fine` + zero touch
 * points, so the touch UI never activates there and the existing E2E flow is
 * untouched.
 */

/** True on phones/tablets — coarse pointer or a real touch digitizer. */
export function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const points = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarse || points || 'ontouchstart' in window;
}

/**
 * Touch capability, sampled once on mount. It does not change for the life of a
 * page, so there's no listener — re-evaluating per render would only churn.
 */
export function useIsTouch(): boolean {
  const [touch] = useState(detectTouch);
  return touch;
}

/** Reactive `matchMedia` — re-renders when the query result flips. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** True while the viewport is taller than it is wide. */
export function usePortrait(): boolean {
  return useMediaQuery('(orientation: portrait)');
}

// ── Fullscreen ───────────────────────────────────────────────────────────────
// iOS Safari on iPhone still has no element Fullscreen API; on those devices the
// requests below resolve to no-ops and we lean on `apple-mobile-web-app-capable`
// + the address-bar-hiding viewport instead. Everything is wrapped so a rejected
// request (no user gesture, unsupported) never surfaces as a console error.

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as FullscreenElement;
  // `typeof` keeps these as capability checks — referencing the methods as
  // values would trip the unbound-method lint.
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as FullscreenDocument;
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** Request fullscreen on the document root. Never rejects — swallows failures. */
export async function enterFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;
  const el = document.documentElement as FullscreenElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {
    // No user gesture / unsupported (iPhone Safari). Degrade silently.
  }
}

/** Exit fullscreen if we're in it. Never rejects. */
export async function exitFullscreen(): Promise<void> {
  if (typeof document === 'undefined' || !isFullscreen()) return;
  const doc = document as FullscreenDocument;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
  } catch {
    // ignore
  }
}

// `ScreenOrientation.lock` is non-standard / not in every TS lib, so we reach it
// through a minimal structural type rather than the global.
type Lockable = { lock?: (orientation: 'landscape') => Promise<void> };

/** Best-effort landscape lock — only works inside fullscreen on Android Chrome. */
export async function lockLandscape(): Promise<void> {
  if (typeof screen === 'undefined' || !screen.orientation) return;
  try {
    await (screen.orientation as Lockable).lock?.('landscape');
  } catch {
    // iOS / desktop / not-fullscreen reject this — that's expected.
  }
}

/** Reactive fullscreen state — re-renders on enter/exit (incl. user ESC/swipe). */
export function useFullscreen(): boolean {
  const [active, setActive] = useState(isFullscreen);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = (): void => setActive(isFullscreen());
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  return active;
}
