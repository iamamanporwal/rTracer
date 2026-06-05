import { RouterProvider } from '@tanstack/react-router';
import { Sentry } from './sentry';
import { router } from './router';
import { MobileShell } from './lib/mobile-shell';

export function App() {
  return (
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <MobileShell>
        <RouterProvider router={router} />
      </MobileShell>
    </Sentry.ErrorBoundary>
  );
}

function ErrorFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8 text-center">
      <div>
        <div className="text-trace-accent font-mono text-xs">FATAL</div>
        <h1 className="mt-2 text-2xl font-semibold">Something derailed.</h1>
        <p className="mt-2 text-trace-muted">
          Reload the page. If it keeps happening, file an issue.
        </p>
      </div>
    </div>
  );
}
