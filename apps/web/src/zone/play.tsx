import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { VehicleManifest, ZoneManifest } from '@trace/core';
import { useStore } from '~/store';
import { loadVehicleManifest, loadZoneManifest, useAsync } from '~/manifests';
import { useIsTouch } from '~/lib/use-device';
import {
  startZoneSession,
  type RaceState,
  type ReplayHandle,
  type ReplayState,
  type SessionStats,
  type ZoneSession,
} from './session';
import { TouchControls } from './touch-controls';
import { PauseMenu } from './pause-menu';
import { Speedometer } from './speedometer';
import { TelemetryOverlay } from './telemetry-overlay';
import { ReplayOverlay } from './replay-overlay';
import { RaceHud } from './race-hud';

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
  const isTouch = useIsTouch();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<ZoneSession | null>(null);
  // Mirror the session into state so the touch pad / pause menu re-render once
  // it's live (refs alone don't trigger a render).
  const [session, setSession] = useState<ZoneSession | null>(null);
  const [stats, setStats] = useState<SessionStats>({
    speedMs: 0,
    fps: 60,
    position: { x: 0, y: 0, z: 0 },
    headingDeg: 0,
    input: {
      throttle: false,
      brake: false,
      left: false,
      right: false,
      handbrake: false,
      up: false,
      down: false,
      arrowLeft: false,
      arrowRight: false,
    },
    telemetry: { recording: false, frameCount: 0, hitCount: 0, durationS: 0 },
  });
  const [weather, setWeather] = useState<string>('Clear');
  const [camera, setCamera] = useState<string>('Chase');
  const [skeleton, setSkeletonState] = useState<boolean>(false);
  const [devMode, setDevModeState] = useState<boolean>(false);
  const [race, setRace] = useState<RaceState | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Replay transport state — non-null while the 3D replay player is open. The
  // handle (control methods) lives in a ref; the state drives the overlay.
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const replayHandleRef = useRef<ReplayHandle | null>(null);

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
      mobile: isTouch,
      onStats: (s) => setStats(s),
      onWeather: (w) => setWeather(w),
      onCameraMode: (m) => setCamera(m),
      onSkeleton: (on) => setSkeletonState(on),
      onRace: (r) => setRace(r),
    })
      .then((s) => {
        if (cancelled) {
          s.dispose();
          return;
        }
        sessionRef.current = s;
        setSession(s);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
      });

    return () => {
      cancelled = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setSession(null);
      // Drop any open replay — its handle is owned by the disposed session.
      replayHandleRef.current = null;
      setReplay(null);
    };
  }, [props.zone, props.vehicle, props.liveryColor, isTouch]);

  const toggleSkeleton = (next: boolean): void => {
    // setSkeleton goes through the session, which fires onSkeleton → React
    // state update. Keeps O-key + menu toggle in sync without optimistic updates.
    sessionRef.current?.setSkeleton(next);
  };

  const toggleDevMode = (next: boolean): void => {
    // Dev mode gates the dev telemetry. Turning it off forces the skeleton
    // overlay off in the session (which fires onSkeleton → React state).
    sessionRef.current?.setDevMode(next);
    setDevModeState(next);
  };

  const downloadTelemetry = (): void => {
    const session = sessionRef.current;
    if (!session) return;
    const csv = session.telemetryCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // ISO timestamp with `:`/`.` stripped so it's a clean filename on every OS.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `rtracer-telemetry-${props.zone.id}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startReplay = (): void => {
    const session = sessionRef.current;
    if (!session) return;
    const handle = session.enterReplay((s) => setReplay(s));
    if (handle) replayHandleRef.current = handle;
  };

  const exitReplay = (): void => {
    replayHandleRef.current?.exit();
    replayHandleRef.current = null;
    setReplay(null);
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
      {/* Live HUD + dev overlays — hidden while the 3D replay player owns the view. */}
      {!replay && <Hud stats={stats} devMode={devMode} isTouch={isTouch} />}
      {devMode && !loading && !replay && (
        <TelemetryOverlay
          input={stats.input}
          telemetry={stats.telemetry}
          isTouch={isTouch}
          onStart={() => sessionRef.current?.startTelemetry()}
          onStop={() => sessionRef.current?.stopTelemetry()}
          onDownload={downloadTelemetry}
          onPlay={startReplay}
        />
      )}
      {devMode && !loading && !replay && session && (
        <RaceHud state={race} controls={session.race} isTouch={isTouch} />
      )}
      {isTouch && !loading && !replay && <TouchControls session={session} />}
      {!loading && !replay && (
        <PauseMenu
          session={session}
          cameraLabel={camera}
          weatherLabel={weather}
          zoneName={props.zone.name}
          vehicleName={props.vehicle.displayName}
          isTouch={isTouch}
          devMode={devMode}
          onDevModeChange={toggleDevMode}
          skeleton={skeleton}
          onSkeletonChange={toggleSkeleton}
          vehicleId={props.vehicle.id}
          vehicleIsBike={props.vehicle.class === 'bike'}
        />
      )}
      {replay && replayHandleRef.current && (
        <ReplayOverlay state={replay} handle={replayHandleRef.current} onExit={exitReplay} />
      )}
    </div>
  );
}

/**
 * In-game HUD. The player view is deliberately clean: just the analog
 * speedometer. Developer telemetry (X/Y/Z/H + FPS) is gated behind dev mode,
 * which the player opts into from the ESC / pause menu. Camera, weather,
 * fullscreen and the navigation exits all live in that menu too.
 */
function Hud(props: { stats: SessionStats; devMode: boolean; isTouch: boolean }) {
  const kmh = props.stats.speedMs * 3.6;

  return (
    <>
      {/* Analog speedometer. Bottom-right on desktop (clear of everything);
          top-right and smaller on touch (the bottom corners are the driving
          pad, top-left is the pause chip). */}
      {props.isTouch ? (
        <div
          className="absolute z-20"
          style={{
            top: 'max(env(safe-area-inset-top), 0.5rem)',
            right: 'max(env(safe-area-inset-right), 0.5rem)',
          }}
        >
          <Speedometer kmh={kmh} size={112} />
        </div>
      ) : (
        <div className="absolute bottom-4 right-4 z-20">
          <Speedometer kmh={kmh} size={190} />
        </div>
      )}

      {props.devMode && <DevReadout stats={props.stats} isTouch={props.isTouch} />}
    </>
  );
}

/** Developer telemetry overlay — only mounted while dev mode is on. On touch it
 * sits below the pause chip (top-left) to avoid overlapping it. */
function DevReadout({ stats, isTouch }: { stats: SessionStats; isTouch: boolean }) {
  const { x, y, z } = stats.position;
  return (
    <div
      className="absolute z-20 px-3 py-2 rounded-md bg-black/55 backdrop-blur text-xs font-mono text-trace-fg leading-snug"
      style={{
        top: isTouch
          ? 'calc(max(env(safe-area-inset-top), 0.75rem) + 4rem)'
          : 'max(env(safe-area-inset-top), 0.75rem)',
        left: 'max(env(safe-area-inset-left), 0.75rem)',
      }}
    >
      <div className="text-trace-accent uppercase tracking-wider text-[10px] mb-1">Dev</div>
      <div className="text-trace-muted">{stats.fps.toFixed(0)} fps</div>
      <div className="mt-1 text-trace-muted">
        <span className="text-trace-accent">X</span> {x.toFixed(1)}
        <br />
        <span className="text-trace-accent">Y</span> {y.toFixed(1)}
        <br />
        <span className="text-trace-accent">Z</span> {z.toFixed(1)}
        <br />
        <span className="text-trace-accent">H</span> {stats.headingDeg.toFixed(1)}°
      </div>
    </div>
  );
}
