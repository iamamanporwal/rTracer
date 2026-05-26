import { useStore } from '~/store';
import { loadVehicleIndex, loadVehicleManifest, useAsync } from '~/manifests';
import type { VehicleManifest } from '@trace/core';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Loader2, TriangleAlert } from 'lucide-react';

export function VehicleSelect() {
  const selected = useStore((s) => s.vehicle.selectedVehicle);
  const selectVehicle = useStore((s) => s.vehicle.selectVehicle);
  const zone = useStore((s) => s.zone.selectedZone);

  const index = useAsync(() => loadVehicleIndex(), []);

  return (
    <div className="max-w-3xl mx-auto">
      <header className="flex items-baseline justify-between">
        <h2 className="text-2xl font-semibold">Vehicles</h2>
        <span className="text-xs font-mono text-trace-muted">step 2 of 2</span>
      </header>
      <p className="text-trace-muted mt-1">Pick what to drive.</p>

      <div className="mt-8 grid grid-cols-1 gap-4">
        {index.status === 'loading' && (
          <div className="h-24 rounded-xl border border-trace-line/50 animate-pulse" />
        )}
        {index.status === 'error' && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-5 text-sm text-red-300">
            <TriangleAlert size={14} className="inline mr-2" />
            {index.error.message}
          </div>
        )}
        {index.status === 'ready' &&
          index.value.map((entry) => (
            <VehicleRow
              key={`${entry.id}:${entry.version}`}
              id={entry.id}
              version={entry.version}
              isSelected={selected?.id === entry.id && selected.version === entry.version}
              onPick={() => selectVehicle(entry)}
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
            to={zone ? '/ready' : '/zones'}
            className="inline-flex items-center gap-2 rounded-lg bg-trace-accent px-4 py-2 text-sm font-medium text-black"
          >
            {zone ? 'Ready to drive' : 'Pick zone'}
            <ArrowRight size={16} />
          </Link>
        </div>
      )}
    </div>
  );
}

function VehicleRow(props: {
  id: string;
  version: string;
  isSelected: boolean;
  onPick: () => void;
}) {
  const manifest = useAsync<VehicleManifest>(
    () => loadVehicleManifest(props.id, props.version),
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
          <div className="mt-2 font-medium">{manifest.value.displayName}</div>
          <div className="mt-1 text-sm text-trace-muted">
            {manifest.value.mass} kg · {manifest.value.engine.redline} rpm ·{' '}
            {manifest.value.gearbox.type} · {manifest.value.gearbox.ratios.length}-speed
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
