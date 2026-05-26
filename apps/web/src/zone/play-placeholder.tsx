import { Link, useParams } from '@tanstack/react-router';
import { useStore } from '~/store';
import { loadZoneManifest, useAsync } from '~/manifests';

/**
 * Play placeholder — last screen before the canvas mounts.
 *
 * Phase 1 W1: validate that the right manifest is reachable from a deep link.
 * W2: replace this with the Three.js mount + Rapier loop.
 */
export function PlayPlaceholder() {
  const { zoneId } = useParams({ from: '/play/$zoneId' });
  const zoneRef = useStore((s) => s.zone.selectedZone);
  const vehicleRef = useStore((s) => s.vehicle.selectedVehicle);

  // Use the store's version if the deep-link id matches; otherwise default to a hard-coded
  // v0.1.0 lookup. The proper resolver will read the zone index in W2.
  const resolvedRef = zoneRef && zoneRef.id === zoneId ? zoneRef : { id: zoneId, version: '0.1.0' };

  const manifest = useAsync(
    () => loadZoneManifest(resolvedRef.id, resolvedRef.version),
    [resolvedRef.id, resolvedRef.version],
  );

  return (
    <div className="max-w-3xl mx-auto text-center mt-12">
      <div className="font-mono text-xs text-trace-muted">{zoneId}</div>
      <h2 className="mt-2 text-3xl font-semibold">Zone canvas mounts here.</h2>
      <p className="mt-3 text-trace-muted">
        Phase 1 W2: Three.js scene + Rapier vehicle on the real zone asset.
      </p>

      <div className="mt-8 mx-auto max-w-md rounded-xl border border-trace-line p-5 text-left">
        <div className="text-xs uppercase tracking-wider font-mono text-trace-accent">manifest</div>
        {manifest.status === 'ready' && (
          <ul className="mt-3 space-y-1 text-sm">
            <li>
              <span className="text-trace-muted">name</span> · {manifest.value.name}
            </li>
            <li>
              <span className="text-trace-muted">physics</span> · {manifest.value.physicsProfile}
            </li>
            <li>
              <span className="text-trace-muted">spawns</span> · {manifest.value.spawnPoints.length}
            </li>
            <li>
              <span className="text-trace-muted">vehicle</span> ·{' '}
              {vehicleRef?.id ?? <em className="text-red-400">none selected</em>}
            </li>
          </ul>
        )}
        {manifest.status === 'loading' && (
          <div className="mt-3 text-sm text-trace-muted">fetching manifest…</div>
        )}
        {manifest.status === 'error' && (
          <div className="mt-3 text-sm text-red-400">{manifest.error.message}</div>
        )}
      </div>

      <Link
        to="/"
        className="inline-block mt-8 px-4 py-2 rounded-lg border border-trace-line hover:border-trace-accent text-sm"
      >
        ← back to hub
      </Link>
    </div>
  );
}
