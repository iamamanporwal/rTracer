import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { VehicleManifest, ZoneManifest } from '@trace/core';
import { useStore } from '~/store';
import { loadVehicleManifest, loadZoneManifest, useAsync } from '~/manifests';
import { startZoneSession, type SessionStats, type ZoneSession } from './session';

/**
 * `/play/$zoneId` route — mounts the Three.js canvas and starts a zone session.
 *
 * Phase 1 W2: programmer-art ground + box-car. Real zone asset and the loading
 * progress UI land in W4 (P1-17..P1-22).
 */
export function Play() {
  const { zoneId } = useParams({ from: '/play/$zoneId' });
  const zoneRef = useStore((s) => s.zone.selectedZone);
  const vehicleRef = useStore((s) => s.vehicle.selectedVehicle);
  const liveryColor = useStore((s) => s.vehicle.liveryColor);

  // Fall back to deep-link defaults if the store hasn't been hydrated (deep load /play/zone_alpha).
  const resolvedZoneRef =
    zoneRef && zoneRef.id === zoneId ? zoneRef : { id: zoneId, version: '0.1.0' };
  const resolvedVehicleRef = vehicleRef ?? { id: 'vehicle_alpha', version: '0.1.0' };

  const zone = useAsync(
    () => loadZoneManifest(resolvedZoneRef.id, resolvedZoneRef.version),
    [resolvedZoneRef.id, resolvedZoneRef.version],
  );
  const vehicle = useAsync(
    () => loadVehicleManifest(resolvedVehicleRef.id, resolvedVehicleRef.version),
    [resolvedVehicleRef.id, resolvedVehicleRef.version],
  );

  const zoneValue = zone.status === 'ready' ? zone.value : null;
  const vehicleValue = vehicle.status === 'ready' ? vehicle.value : null;
  const zoneError = zone.status === 'error' ? zone.error : null;
  const vehicleError = vehicle.status === 'error' ? vehicle.error : null;

  if (zoneError || vehicleError) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <h2 className="text-2xl font-semibold text-red-400">Manifest failed to load.</h2>
        <pre className="mt-4 p-4 rounded-lg border border-trace-line text-xs text-left whitespace-pre-wrap">
          {(zoneError ?? vehicleError)?.message}
        </pre>
        <Link
          to="/"
          className="inline-block mt-6 px-4 py-2 rounded-lg border border-trace-line text-sm"
        >
          ← Garage
        </Link>
      </div>
    );
  }

  if (!zoneValue || !vehicleValue) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <div className="font-mono text-xs uppercase tracking-wider text-trace-muted">{zoneId}</div>
        <h2 className="mt-2 text-2xl font-semibold">Loading manifests…</h2>
      </div>
    );
  }

  return (
    <CanvasMount zone={zoneValue} vehicle={vehicleValue} liveryColor={liveryColor} />
  );
}

function CanvasMount(props: {
  zone: ZoneManifest;
  vehicle: VehicleManifest;
  liveryColor: `#${string}`;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<ZoneSession | null>(null);
  const [stats, setStats] = useState<SessionStats>({ speedMs: 0, fps: 60 });
  const [weather, setWeather] = useState<string>('Clear');
  const [camera, setCamera] = useState<string>('Chase');
  const [skeleton, setSkeletonState] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    setLoading(true);

    startZoneSession({
      canvas,
      zoneManifest: props.zone,
      vehicleManifest: props.vehicle,
      liveryColor: props.liveryColor,
      onStats: (s) => setStats(s),
      onWeather: (w) => setWeather(w),
      onCameraMode: (m) => setCamera(m),
      onSkeleton: (on) => setSkeletonState(on),
    })
      .then((s) => {
        if (cancelled) {
          s.dispose();
          return;
        }
        sessionRef.current = s;
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
      });

    return () => {
      cancelled = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [props.zone, props.vehicle, props.liveryColor]);

  const toggleSkeleton = (next: boolean): void => {
    // setSkeleton goes through the session, which fires onSkeleton → React
    // state update. Keeps O-key + checkbox in sync without optimistic updates.
    sessionRef.current?.setSkeleton(next);
  };

  if (error) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <h2 className="text-2xl font-semibold text-red-400">Session failed to start.</h2>
        <pre className="mt-4 p-4 rounded-lg border border-trace-line text-xs text-left whitespace-pre-wrap">
          {error.message}
        </pre>
        <Link
          to="/"
          className="inline-block mt-6 px-4 py-2 rounded-lg border border-trace-line text-sm"
        >
          ← Garage
        </Link>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black">
      <canvas ref={canvasRef} className="block w-full h-full outline-none" tabIndex={0} />
      {loading && (
        <div className="absolute inset-0 grid place-items-center bg-black/70 backdrop-blur-sm">
          <div className="text-center">
            <div className="font-mono text-xs uppercase tracking-wider text-trace-muted">
              {props.vehicle.displayName}
            </div>
            <div className="mt-2 flex items-center gap-3 text-trace-fg">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-trace-line border-t-trace-accent" />
              Loading vehicle…
            </div>
          </div>
        </div>
      )}
      <Hud
        zone={props.zone}
        vehicle={props.vehicle}
        stats={stats}
        weather={weather}
        camera={camera}
        skeleton={skeleton}
        onSkeletonChange={toggleSkeleton}
      />
    </div>
  );
}

function Hud(props: {
  zone: ZoneManifest;
  vehicle: VehicleManifest;
  stats: SessionStats;
  weather: string;
  camera: string;
  skeleton: boolean;
  onSkeletonChange: (next: boolean) => void;
}) {
  const kmh = props.stats.speedMs * 3.6;
  return (
    <>
      <div className="absolute top-3 left-3 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-xs font-mono text-trace-fg">
        <div className="text-trace-accent">{props.zone.name}</div>
        <div className="text-trace-muted">
          {props.vehicle.displayName} · {props.zone.physicsProfile}
        </div>
        <div className="text-trace-muted">
          weather · {props.weather} · cam · {props.camera}
        </div>
      </div>
      <div className="absolute top-3 right-3 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-xs font-mono text-right">
        <div data-testid="hud-speed-kmh" className="text-trace-fg text-2xl leading-none">
          {kmh.toFixed(0)}
        </div>
        <div className="text-trace-muted uppercase tracking-wider">km/h</div>
        <div className="text-trace-muted mt-1">{props.stats.fps.toFixed(0)} fps</div>
      </div>
      {/* Invisible-Skeleton toggle — surfaces the physics debug overlay
          (colliders, suspension rays, contacts, COM, velocity) that makes the
          car's underlying tire and chassis simulation visible. The O hotkey
          still works; this checkbox is just a discoverable alternative. */}
      <label
        className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-xs font-mono text-trace-fg flex items-center gap-2 cursor-pointer select-none hover:text-trace-accent"
        title="Show the physics rig — colliders, suspension rays, connection nodes (purple = body mount, orange = wheel hub), wheel contacts, COM, velocity (hotkey: O)"
      >
        <input
          type="checkbox"
          checked={props.skeleton}
          onChange={(e) => props.onSkeletonChange(e.target.checked)}
          className="accent-trace-accent"
          data-testid="hud-skeleton-toggle"
        />
        <span>Invisible Skeleton</span>
      </label>
      <div className="absolute bottom-3 left-3 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-[11px] font-mono text-trace-muted">
        W/S drive · A/D steer · Space handbrake/drift · R reset · C camera · Y weather · O debug ·
        Mouse look · Wheel zoom
      </div>
      <Link
        to="/"
        className="absolute bottom-3 right-3 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-xs text-trace-fg hover:text-trace-accent"
      >
        ← back to hub
      </Link>
    </>
  );
}
