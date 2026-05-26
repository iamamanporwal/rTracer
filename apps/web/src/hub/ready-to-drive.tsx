import { Link } from '@tanstack/react-router';
import { ArrowRight, MapPinned, Car } from 'lucide-react';
import { useStore } from '~/store';
import { loadZoneManifest, loadVehicleManifest, useAsync } from '~/manifests';

/**
 * "About to load zone" screen — blueprint §21.2 W1 demo target.
 *
 * Shows both selections with their resolved manifest data and a single Start
 * CTA. If either selection is missing we punt back to the picker.
 */
export function ReadyToDrive() {
  const zoneRef = useStore((s) => s.zone.selectedZone);
  const vehicleRef = useStore((s) => s.vehicle.selectedVehicle);

  const zone = useAsync(
    () =>
      zoneRef
        ? loadZoneManifest(zoneRef.id, zoneRef.version)
        : Promise.reject(new Error('no zone selected')),
    [zoneRef?.id, zoneRef?.version],
  );

  const vehicle = useAsync(
    () =>
      vehicleRef
        ? loadVehicleManifest(vehicleRef.id, vehicleRef.version)
        : Promise.reject(new Error('no vehicle selected')),
    [vehicleRef?.id, vehicleRef?.version],
  );

  if (!zoneRef || !vehicleRef) {
    return (
      <div className="max-w-3xl mx-auto text-center mt-16">
        <h2 className="text-2xl font-semibold">Pick a zone and a vehicle first.</h2>
        <div className="mt-6 flex justify-center gap-3">
          {!zoneRef && (
            <Link
              to="/zones"
              className="rounded-lg border border-trace-line hover:border-trace-accent px-4 py-2 text-sm"
            >
              Pick zone
            </Link>
          )}
          {!vehicleRef && (
            <Link
              to="/vehicles"
              className="rounded-lg border border-trace-line hover:border-trace-accent px-4 py-2 text-sm"
            >
              Pick vehicle
            </Link>
          )}
        </div>
      </div>
    );
  }

  const canStart = zone.status === 'ready' && vehicle.status === 'ready';

  return (
    <div className="max-w-3xl mx-auto">
      <header>
        <div className="font-mono text-xs text-trace-muted">ready to drive</div>
        <h2 className="mt-1 text-3xl font-semibold">Pre-flight check</h2>
      </header>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
        <SummaryCard
          icon={<MapPinned size={18} />}
          kind="Zone"
          ref={zoneRef}
          line2={
            zone.status === 'ready'
              ? `${zone.value.name} · ${zone.value.physicsProfile} · ${zone.value.fidelityTier}`
              : zone.status === 'error'
                ? zone.error.message
                : 'loading manifest…'
          }
        />
        <SummaryCard
          icon={<Car size={18} />}
          kind="Vehicle"
          ref={vehicleRef}
          line2={
            vehicle.status === 'ready'
              ? `${vehicle.value.displayName} · ${vehicle.value.mass} kg · ${vehicle.value.gearbox.type}`
              : vehicle.status === 'error'
                ? vehicle.error.message
                : 'loading manifest…'
          }
        />
      </div>

      <div className="mt-10 flex items-center justify-between rounded-xl border border-trace-line p-5">
        <p className="text-trace-muted text-sm">
          Phase 1 W1: manifest validated, canvas mount lands W2.
        </p>
        <Link
          to="/play/$zoneId"
          params={{ zoneId: zoneRef.id }}
          disabled={!canStart}
          className={
            'inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium ' +
            (canStart
              ? 'bg-trace-accent text-black'
              : 'bg-trace-line text-trace-muted pointer-events-none')
          }
        >
          Start
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}

function SummaryCard(props: {
  icon: React.ReactNode;
  kind: string;
  ref: { id: string; version: string };
  line2: string;
}) {
  return (
    <div className="rounded-xl border border-trace-line p-5">
      <div className="flex items-center gap-2 text-trace-accent">
        {props.icon}
        <span className="text-xs uppercase tracking-wider font-mono">{props.kind}</span>
      </div>
      <div className="mt-3 font-mono text-xs text-trace-muted">
        {props.ref.id} · v{props.ref.version}
      </div>
      <div className="mt-1 text-sm">{props.line2}</div>
    </div>
  );
}
