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
          ← back to hub
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
  const [stats, setStats] = useState<SessionStats>({ speedMs: 0, fps: 60 });
  const [weather, setWeather] = useState<string>('Clear');
  const [camera, setCamera] = useState<string>('Chase');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let session: ZoneSession | null = null;
    let cancelled = false;

    startZoneSession({
      canvas,
      zoneManifest: props.zone,
      vehicleManifest: props.vehicle,
      liveryColor: props.liveryColor,
      onStats: (s) => setStats(s),
      onWeather: (w) => setWeather(w),
      onCameraMode: (m) => setCamera(m),
    })
      .then((s) => {
        if (cancelled) {
          s.dispose();
          return;
        }
        session = s;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
      });

    return () => {
      cancelled = true;
      session?.dispose();
    };
  }, [props.zone, props.vehicle, props.liveryColor]);

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
          ← back to hub
        </Link>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 top-[60px] bg-black">
      <canvas ref={canvasRef} className="block w-full h-full outline-none" tabIndex={0} />
      <Hud
        zone={props.zone}
        vehicle={props.vehicle}
        stats={stats}
        weather={weather}
        camera={camera}
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
        <div className="text-trace-fg text-2xl leading-none">{kmh.toFixed(0)}</div>
        <div className="text-trace-muted uppercase tracking-wider">km/h</div>
        <div className="text-trace-muted mt-1">{props.stats.fps.toFixed(0)} fps</div>
      </div>
      <div className="absolute bottom-3 left-3 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-[11px] font-mono text-trace-muted">
        W/S drive · A/D steer · Space handbrake · R reset · C camera · Y weather · Mouse look · Wheel
        zoom
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
