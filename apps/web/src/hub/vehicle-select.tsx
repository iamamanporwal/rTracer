import { useStore } from '~/store';

export function VehicleSelect() {
  const selected = useStore((s) => s.vehicle.selectedVehicleId);
  const selectVehicle = useStore((s) => s.vehicle.selectVehicle);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-semibold">Vehicles</h2>
      <p className="text-trace-muted mt-1">
        Phase 0 placeholder. The Phase 1 demo car drops at Week 3.
      </p>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {['vehicle_demo'].map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => selectVehicle(id)}
            className={
              'text-left rounded-xl border px-5 py-6 transition-colors ' +
              (selected === id
                ? 'border-trace-accent bg-trace-accent/5'
                : 'border-trace-line hover:border-trace-accent')
            }
          >
            <div className="font-mono text-xs text-trace-muted">{id}</div>
            <div className="mt-2 font-medium">Demo Vehicle</div>
            <div className="text-sm text-trace-muted">Placeholder until Phase 1.</div>
          </button>
        ))}
      </div>
    </div>
  );
}
