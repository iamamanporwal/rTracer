import { Link } from '@tanstack/react-router';
import { Car, IdCard, MapPinned, ArrowRight } from 'lucide-react';
import { useStore } from '~/store';

/**
 * Hub landing. The flow is zones → vehicles → ready → play. When the player
 * has already picked both sides, surface a "Continue" CTA at the top so they
 * can resume without re-tapping through.
 */
export function HubLanding() {
  const zone = useStore((s) => s.zone.selectedZone);
  const vehicle = useStore((s) => s.vehicle.selectedVehicle);
  const hasBoth = !!zone && !!vehicle;

  return (
    <div className="max-w-5xl mx-auto">
      <section className="mb-12">
        <h1 className="text-5xl font-semibold tracking-tight">
          Hello, <span className="text-trace-accent">Trace</span>.
        </h1>
        <p className="mt-4 text-trace-muted max-w-2xl">
          Browser-native motorsport sandbox. Pick a zone, pick a vehicle, drive. The canvas mount
          lands in Week 2; this slice validates the manifests under it.
        </p>

        {hasBoth && (
          <Link
            to="/ready"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-trace-accent px-4 py-2 text-sm font-medium text-black"
          >
            Continue → {zone.id} + {vehicle.id}
            <ArrowRight size={16} />
          </Link>
        )}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <HubCard
          to="/zones"
          icon={<MapPinned size={20} />}
          title="Zones"
          subtitle={zone ? `selected · ${zone.id}` : 'Pick a place to drive'}
          isPicked={!!zone}
        />
        <HubCard
          to="/vehicles"
          icon={<Car size={20} />}
          title="Vehicles"
          subtitle={vehicle ? `selected · ${vehicle.id}` : 'Pick what to drive'}
          isPicked={!!vehicle}
        />
        <HubCard
          to="/passport"
          icon={<IdCard size={20} />}
          title="Passport"
          subtitle="Stamps + best laps"
          isPicked={false}
        />
      </section>
    </div>
  );
}

function HubCard(props: {
  to: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  isPicked: boolean;
}) {
  return (
    <Link
      to={props.to}
      className={
        'block rounded-xl border bg-black/30 px-5 py-6 transition-colors ' +
        (props.isPicked ? 'border-trace-accent' : 'border-trace-line hover:border-trace-accent')
      }
    >
      <div className="flex items-center gap-3 text-trace-accent">{props.icon}</div>
      <div className="mt-3 font-medium">{props.title}</div>
      <div className="text-sm text-trace-muted">{props.subtitle}</div>
    </Link>
  );
}
