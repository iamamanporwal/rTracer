import { createRootRoute, createRoute, createRouter, Outlet, Link } from '@tanstack/react-router';
import { HubLanding } from './hub/hub-landing';
import { ZoneSelect } from './hub/zone-select';
import { VehicleSelect } from './hub/vehicle-select';
import { ReadyToDrive } from './hub/ready-to-drive';
import { PassportView } from './passport/passport-view';
import { Play } from './zone/play';

const rootRoute = createRootRoute({
  component: function Root() {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-trace-line px-6 py-4 flex items-center justify-between">
          <Link to="/" className="font-mono text-lg tracking-wide text-trace-accent">
            TRACE
          </Link>
          <nav className="flex gap-6 text-sm text-trace-muted">
            <Link
              to="/zones"
              className="hover:text-trace-fg"
              activeProps={{ className: 'text-trace-fg' }}
            >
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
          </nav>
        </header>
        <main className="flex-1 px-6 py-10">
          <Outlet />
        </main>
        <footer className="border-t border-trace-line px-6 py-3 text-xs text-trace-muted font-mono">
          phase 1 · w2 · {import.meta.env.MODE}
        </footer>
      </div>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HubLanding,
});

const zonesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/zones',
  component: ZoneSelect,
});

const vehiclesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/vehicles',
  component: VehicleSelect,
});

const passportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/passport',
  component: PassportView,
});

const readyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ready',
  component: ReadyToDrive,
});

const playRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/play/$zoneId',
  component: Play,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  zonesRoute,
  vehiclesRoute,
  readyRoute,
  passportRoute,
  playRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
