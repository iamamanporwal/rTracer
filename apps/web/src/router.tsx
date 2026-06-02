import { createRootRoute, createRoute, createRouter, Outlet, Link } from '@tanstack/react-router';
import { Garage } from './game/garage';
import { MapSelect } from './game/map-select';
import { HubLanding } from './hub/hub-landing';
import { ZoneSelect } from './hub/zone-select';
import { VehicleSelect } from './hub/vehicle-select';
import { ReadyToDrive } from './hub/ready-to-drive';
import { PassportView } from './passport/passport-view';
import { Play } from './zone/play';

/**
 * Two shells share one router:
 *  - Game mode (player): full-bleed, no chrome — Garage (`/`) and Play.
 *  - Dev mode (internal): the manifest hub, wrapped in a header/footer layout
 *    and parked under `/dev`, `/zones`, … (reached today via the discreet
 *    "dev" link in the Garage; buried in Settings in M2).
 */

const rootRoute = createRootRoute({
  component: function Root() {
    return <Outlet />;
  },
});

// ── Game mode (no chrome) ────────────────────────────────────────────────────

const garageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Garage,
});

const mapSelectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/maps',
  component: MapSelect,
});

const playRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/play/$zoneId',
  component: Play,
});

// ── Dev mode (header/footer chrome) ──────────────────────────────────────────

const devLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'dev-shell',
  component: function DevShell() {
    return (
      <div className="min-h-screen flex flex-col bg-trace-bg text-trace-fg">
        <header className="border-b border-trace-line px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/dev" className="font-mono text-lg tracking-wide text-trace-accent">
              TRACE
            </Link>
            <span className="rounded bg-trace-line/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-trace-muted">
              dev
            </span>
          </div>
          <nav className="flex gap-6 text-sm text-trace-muted">
            <Link to="/zones" className="hover:text-trace-fg" activeProps={{ className: 'text-trace-fg' }}>
              Zones
            </Link>
            <Link
              to="/vehicles"
              className="hover:text-trace-fg"
              activeProps={{ className: 'text-trace-fg' }}
            >
              Vehicles
            </Link>
            <Link
              to="/passport"
              className="hover:text-trace-fg"
              activeProps={{ className: 'text-trace-fg' }}
            >
              Passport
            </Link>
            <Link to="/" className="text-trace-muted hover:text-trace-accent">
              ← Game
            </Link>
          </nav>
        </header>
        <main className="flex-1 px-6 py-10">
          <Outlet />
        </main>
        <footer className="border-t border-trace-line px-6 py-3 text-xs text-trace-muted font-mono">
          dev mode · phase 1 · {import.meta.env.MODE}
        </footer>
      </div>
    );
  },
});

const devHomeRoute = createRoute({
  getParentRoute: () => devLayoutRoute,
  path: '/dev',
  component: HubLanding,
});

const zonesRoute = createRoute({
  getParentRoute: () => devLayoutRoute,
  path: '/zones',
  component: ZoneSelect,
});

const vehiclesRoute = createRoute({
  getParentRoute: () => devLayoutRoute,
  path: '/vehicles',
  component: VehicleSelect,
});

const readyRoute = createRoute({
  getParentRoute: () => devLayoutRoute,
  path: '/ready',
  component: ReadyToDrive,
});

const passportRoute = createRoute({
  getParentRoute: () => devLayoutRoute,
  path: '/passport',
  component: PassportView,
});

const routeTree = rootRoute.addChildren([
  garageRoute,
  mapSelectRoute,
  playRoute,
  devLayoutRoute.addChildren([
    devHomeRoute,
    zonesRoute,
    vehiclesRoute,
    readyRoute,
    passportRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
