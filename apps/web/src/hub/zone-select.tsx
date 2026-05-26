import { useStore } from '~/store';
import { loadZoneIndex, loadZoneManifest, useAsync } from '~/manifests';
import type { ZoneManifest } from '@trace/core';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Loader2, TriangleAlert } from 'lucide-react';

export function ZoneSelect() {
  const selected = useStore((s) => s.zone.selectedZone);
  const selectZone = useStore((s) => s.zone.selectZone);
  const vehicle = useStore((s) => s.vehicle.selectedVehicle);

  const index = useAsync(() => loadZoneIndex(), []);

  return (
    <div className="max-w-3xl mx-auto">
      <header className="flex items-baseline justify-between">
        <h2 className="text-2xl font-semibold">Zones</h2>
        <span className="text-xs font-mono text-trace-muted">step 1 of 2</span>
      </header>
      <p className="text-trace-muted mt-1">Pick a place to drive.</p>

      <div className="mt-8 grid grid-cols-1 gap-4">
        {index.status === 'loading' && <ListSkeleton />}
        {index.status === 'error' && <ListError message={index.error.message} />}
        {index.status === 'ready' &&
          index.value.map((entry) => (
            <ZoneRow
              key={`${entry.id}:${entry.version}`}
              id={entry.id}
              version={entry.version}
              isSelected={selected?.id === entry.id && selected.version === entry.version}
              onPick={() => selectZone(entry)}
            />
          ))}
      </div>

      {selected && (
        <div className="mt-10 flex items-center justify-between rounded-xl border border-trace-line p-5">
          <div>
            <div className="text-xs font-mono text-trace-muted">selected</div>
            <div className="mt-1 font-medium">{selected.id}</div>
          </div>
          <Link
            to={vehicle ? '/ready' : '/vehicles'}
            className="inline-flex items-center gap-2 rounded-lg bg-trace-accent px-4 py-2 text-sm font-medium text-black"
          >
            {vehicle ? 'Ready to drive' : 'Pick vehicle'}
            <ArrowRight size={16} />
          </Link>
        </div>
      )}
    </div>
  );
}

function ZoneRow(props: { id: string; version: string; isSelected: boolean; onPick: () => void }) {
  const manifest = useAsync<ZoneManifest>(
    () => loadZoneManifest(props.id, props.version),
    [props.id, props.version],
  );

  return (
    <button
      type="button"
      onClick={props.onPick}
      className={
        'text-left rounded-xl border px-5 py-6 transition-colors ' +
        (props.isSelected
          ? 'border-trace-accent bg-trace-accent/5'
          : 'border-trace-line hover:border-trace-accent')
      }
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-xs text-trace-muted">
          {props.id} · v{props.version}
        </div>
        {manifest.status === 'loading' && <Loader2 size={14} className="animate-spin opacity-60" />}
      </div>
      {manifest.status === 'ready' ? (
        <>
          <div className="mt-2 font-medium">{manifest.value.name}</div>
          <div className="mt-1 text-sm text-trace-muted">
            {manifest.value.physicsProfile} · {manifest.value.fidelityTier} fidelity ·{' '}
            {manifest.value.modesSupported.join(' / ')}
          </div>
        </>
      ) : manifest.status === 'error' ? (
        <div className="mt-2 text-sm text-red-400">
          <TriangleAlert size={14} className="inline mr-1" />
          {manifest.error.message}
        </div>
      ) : (
        <div className="mt-2 h-4 w-32 bg-trace-line/60 rounded" />
      )}
    </button>
  );
}

function ListSkeleton() {
  return (
    <>
      <div className="h-24 rounded-xl border border-trace-line/50 animate-pulse" />
      <div className="h-24 rounded-xl border border-trace-line/50 animate-pulse" />
    </>
  );
}

function ListError(props: { message: string }) {
  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-5 text-sm text-red-300">
      <TriangleAlert size={14} className="inline mr-2" />
      {props.message}
    </div>
  );
}
