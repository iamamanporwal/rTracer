import { useParams, Link } from '@tanstack/react-router';

export function PlayPlaceholder() {
  const { zoneId } = useParams({ from: '/play/$zoneId' });

  return (
    <div className="max-w-3xl mx-auto text-center mt-12">
      <div className="font-mono text-xs text-trace-muted">{zoneId}</div>
      <h2 className="mt-2 text-3xl font-semibold">Zone canvas mounts here.</h2>
      <p className="mt-3 text-trace-muted">
        Phase 1 Week 4: Three.js scene + Rapier vehicle on the real zone asset.
      </p>
      <Link
        to="/"
        className="inline-block mt-8 px-4 py-2 rounded-lg border border-trace-line hover:border-trace-accent text-sm"
      >
        ← back to hub
      </Link>
    </div>
  );
}
