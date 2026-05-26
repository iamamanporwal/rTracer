import { Link } from '@tanstack/react-router';
import { Gauge, MapPinned, Car, IdCard } from 'lucide-react';

/**
 * Hub landing — Phase 0 surface. "Hello Trace" satisfies P0-03; the cards
 * are placeholders for the Phase 1 W1 hub shell.
 */
export function HubLanding() {
  return (
    <div className="max-w-5xl mx-auto">
      <section className="mb-12">
        <h1 className="text-5xl font-semibold tracking-tight">
          Hello, <span className="text-trace-accent">Trace</span>.
        </h1>
        <p className="mt-4 text-trace-muted max-w-2xl">
          Browser-native motorsport sandbox. Hub world, addressable zones, a player passport. This
          is Phase 0 — the shell. Real driving lands in Phase 1.
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HubCard
          to="/zones"
          icon={<MapPinned size={20} />}
          title="Zones"
          subtitle="Pick a place to drive"
        />
        <HubCard
          to="/vehicles"
          icon={<Car size={20} />}
          title="Vehicles"
          subtitle="Pick what to drive"
        />
        <HubCard
          to="/passport"
          icon={<IdCard size={20} />}
          title="Passport"
          subtitle="Stamps + best laps"
        />
        <HubCard
          to="/play/zone_demo"
          icon={<Gauge size={20} />}
          title="Quickdrive"
          subtitle="(stub)"
        />
      </section>
    </div>
  );
}

function HubCard(props: { to: string; icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <Link
      to={props.to}
      className="block rounded-xl border border-trace-line bg-black/30 px-5 py-6 hover:border-trace-accent transition-colors"
    >
      <div className="flex items-center gap-3 text-trace-accent">{props.icon}</div>
      <div className="mt-3 font-medium">{props.title}</div>
      <div className="text-sm text-trace-muted">{props.subtitle}</div>
    </Link>
  );
}
