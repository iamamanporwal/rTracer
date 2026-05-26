import * as Sentry from '@sentry/react';

/**
 * Sentry init. No-op when VITE_SENTRY_DSN is not set, so devs can run without
 * touching Sentry. CI populates the DSN + auth token (see vite.config.ts).
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    if (import.meta.env.DEV) {
      console.warn('[sentry] VITE_SENTRY_DSN not set — telemetry disabled');
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE ?? 'dev',
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
  });
}

export { Sentry };
