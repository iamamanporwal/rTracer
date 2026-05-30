import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Car, Truck, Loader2, TriangleAlert } from 'lucide-react';
import { vehicleBundleDir, type VehicleManifest } from '@trace/core';
import { useStore } from '~/store';
import { loadVehicleIndex, loadVehicleManifest, useAsync } from '~/manifests';
import type { ManifestRef } from '~/store';

/**
 * Game-mode Garage / Car Select — the player-facing front door.
 *
 * Reskins the same manifest data the dev hub uses (see `hub/vehicle-select`)
 * into a "Need for Speed: Most Wanted" cold-blue car select: one hero car,
 * a left/right carousel, segmented stat meters, and a single DRIVE CTA that
 * sets the store selection and drops into the live `/play` session.
 *
 * Live 3D turntable render, livery, and the Title/Main-Menu shell are M2–M4;
 * this is the M1 vertical slice.
 */

const DEFAULT_ZONE_ID = 'zone_alpha';

type Loaded = { ref: ManifestRef; manifest: VehicleManifest };

export function Garage() {
  const data = useAsync<Loaded[]>(async () => {
    const index = await loadVehicleIndex();
    const settled = await Promise.allSettled(
      index.map(async (ref) => ({
        ref: ref as ManifestRef,
        manifest: await loadVehicleManifest(ref.id, ref.version),
      })),
    );
    const ok = settled.filter((s): s is PromiseFulfilledResult<Loaded> => s.status === 'fulfilled');
    if (ok.length === 0) throw new Error('No vehicles could be loaded.');
    return ok.map((s) => s.value);
  }, []);

  if (data.status === 'ready') return <GarageStage cars={data.value} />;

  return (
    <Shell>
      <div className="grid h-full place-items-center">
        {data.status === 'error' ? (
          <div className="text-center text-mw-muted">
            <TriangleAlert className="mx-auto mb-3 text-mw-hot" size={28} />
            <div className="font-display text-2xl uppercase tracking-wide text-mw-text">
              Garage unavailable
            </div>
            <p className="mt-1 font-mono text-xs">{data.error.message}</p>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-mw-muted">
            <Loader2 className="animate-spin text-mw-accent" size={18} />
            <span className="font-mono text-xs uppercase tracking-[0.3em]">Loading garage…</span>
          </div>
        )}
      </div>
    </Shell>
  );
}

function GarageStage({ cars }: { cars: Loaded[] }) {
  const navigate = useNavigate();
  const selectVehicle = useStore((s) => s.vehicle.selectVehicle);
  const selectedZone = useStore((s) => s.zone.selectedZone);

  const [i, setI] = useState(0);
  const total = cars.length;
  // `i` stays in range via the modulo navigation, but indexed access is typed
  // as possibly-undefined — narrow once, after the hooks (see guard below).
  const current = cars[i];
  const spec = useMemo(() => (current ? deriveSpec(current.manifest) : null), [current]);

  const next = () => setI((p) => (p + 1) % total);
  const prev = () => setI((p) => (p - 1 + total) % total);

  function drive() {
    if (!current) return;
    selectVehicle(current.ref);
    void navigate({
      to: '/play/$zoneId',
      params: { zoneId: selectedZone?.id ?? DEFAULT_ZONE_ID },
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'Enter') drive();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, current?.ref.id, selectedZone?.id]);

  if (!current || !spec) return null;
  const previewUrl = current.manifest.preview
    ? `${vehicleBundleDir(current.ref.id, current.ref.version)}/${current.manifest.preview}`
    : null;

  return (
    <Shell>
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-6 pt-6 sm:px-10">
        <div className="font-mono text-[11px] uppercase tracking-[0.4em] text-mw-muted">
          TRACE <span className="text-mw-accent">{'// Garage'}</span>
        </div>
        <div className="font-display text-sm tracking-[0.3em] text-mw-muted">
          <span className="text-mw-text">{String(i + 1).padStart(2, '0')}</span> /{' '}
          {String(total).padStart(2, '0')}
        </div>
      </header>

      {/* Stage */}
      <main className="relative flex-1">
        {/* Hero art — real image when the manifest has a preview, silhouette otherwise. */}
        <HeroArt
          key={`art-${current.ref.id}`}
          previewUrl={previewUrl}
          classLabel={spec.classLabel}
          displayName={current.manifest.displayName}
        />

        {/* Bottom info-panel readability scrim */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-mw-bg via-mw-bg/80 to-transparent" />

        {/* Carousel arrows */}
        <Arrow side="left" onClick={prev} />
        <Arrow side="right" onClick={next} />

        {/* Info + meters */}
        <div className="absolute inset-x-0 bottom-0 px-6 pb-6 sm:px-10">
          <div
            key={`info-${current.ref.id}`}
            className="mw-rise mx-auto grid w-full max-w-6xl items-end gap-8 lg:grid-cols-[1fr_auto]"
          >
            <div>
              <div className="flex items-center gap-3 font-display text-sm uppercase tracking-[0.35em] text-mw-accent">
                <span className="h-2 w-2 -skew-x-12 bg-mw-accent" />
                Class · {spec.classLabel}
              </div>
              <h1 className="mt-2 font-display text-5xl font-bold uppercase leading-[0.9] tracking-tight text-mw-text sm:text-6xl lg:text-7xl xl:text-8xl">
                {current.manifest.displayName}
              </h1>
              <div className="mt-3 font-mono text-xs uppercase tracking-[0.25em] text-mw-muted">
                {spec.drivetrain} · {spec.powerHp} HP · {spec.gearLabel} · {spec.redline} RPM
              </div>

              <button
                type="button"
                onClick={drive}
                className="group mt-7 inline-flex -skew-x-12 items-center gap-3 bg-mw-accent px-9 py-3.5 shadow-[0_0_34px_rgba(54,166,255,0.45)] transition-colors hover:bg-white"
              >
                <span className="skew-x-12 font-display text-xl font-bold uppercase tracking-[0.2em] text-mw-bg">
                  Drive
                </span>
                <ChevronRight className="skew-x-12 text-mw-bg" size={22} strokeWidth={3} />
              </button>
            </div>

            {/* Stat panel */}
            <div className="w-full -skew-x-6 border border-mw-edge/60 bg-mw-panel/70 p-5 backdrop-blur-sm lg:w-[22rem]">
              <div className="skew-x-6 space-y-3.5">
                <Meter label="Power" value={spec.meters.power} readout={`${spec.powerHp} hp`} />
                <Meter label="Top Speed" value={spec.meters.top} readout={`${spec.topKmh} km/h`} />
                <Meter label="Grip" value={spec.meters.grip} readout={pct(spec.meters.grip)} />
                <Meter label="Agility" value={spec.meters.agility} readout={pct(spec.meters.agility)} />
                <div className="flex items-center justify-between border-t border-mw-edge/50 pt-3 font-mono text-[11px] uppercase tracking-wider text-mw-muted">
                  <span>Weight</span>
                  <span className="text-mw-text">{(current.manifest.mass / 1000).toFixed(2)} t</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Thumbnail strip */}
      <footer className="relative z-10 border-t border-mw-edge/40 bg-mw-bg/60 px-6 py-4 backdrop-blur-sm sm:px-10">
        <div className="mx-auto flex max-w-6xl gap-2.5 overflow-x-auto">
          {cars.map((c, idx) => (
            <button
              key={c.ref.id}
              type="button"
              onClick={() => setI(idx)}
              className={
                'flex min-w-[8.5rem] flex-1 items-center gap-3 border px-3.5 py-2.5 text-left transition-colors ' +
                (idx === i
                  ? 'border-mw-accent bg-mw-steel'
                  : 'border-mw-edge/50 hover:border-mw-accent/60')
              }
            >
              <span
                className={
                  'font-display text-lg font-semibold tabular-nums ' +
                  (idx === i ? 'text-mw-accent' : 'text-mw-muted')
                }
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
              <span
                className={
                  'truncate font-display text-sm uppercase tracking-wide ' +
                  (idx === i ? 'text-mw-text' : 'text-mw-muted')
                }
              >
                {c.manifest.displayName}
              </span>
            </button>
          ))}
        </div>
      </footer>

      {/* Discreet dev-mode entry (buried in Settings in M2) */}
      <Link
        to="/dev"
        className="absolute bottom-1.5 right-3 z-20 font-mono text-[10px] uppercase tracking-[0.3em] text-mw-muted/40 transition-colors hover:text-mw-accent"
      >
        dev
      </Link>
    </Shell>
  );
}

/** Full-screen MW backdrop: cold radial glow, speed streaks, and a vignette. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-mw-bg font-display text-mw-text">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(54,166,255,0.16),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background:repeating-linear-gradient(115deg,transparent_0,transparent_38px,#36a6ff_38px,#36a6ff_40px)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.85))]" />
      {children}
    </div>
  );
}

/**
 * Hero art layer behind the car name. Uses the real preview image when the
 * manifest provides one; falls back to a Lucide silhouette so the alpha demo
 * car (or any manifest without art) still has presence on the screen instead
 * of a flat blue void. The image is desaturated and tinted to sit inside the
 * Most-Wanted cold-blue palette rather than clashing with it.
 */
function HeroArt({
  previewUrl,
  classLabel,
  displayName,
}: {
  previewUrl: string | null;
  classLabel: Spec['classLabel'];
  displayName: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = previewUrl && !imgFailed;
  const Glyph = classLabel === 'All-terrain' ? Truck : Car;

  return (
    <div className="mw-fade pointer-events-none absolute inset-0">
      {showImage ? (
        <>
          <img
            src={previewUrl}
            alt={displayName}
            onError={() => setImgFailed(true)}
            className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2 object-contain opacity-90 saturate-[0.85] mix-blend-screen drop-shadow-[0_30px_60px_rgba(0,0,0,0.55)]"
            style={{ width: 'min(82vw, 1100px)', maxHeight: '70vh' }}
            draggable={false}
          />
          {/* Soft cyan rim glow + horizon line, kept from the silhouette layout. */}
          <div
            className="absolute left-1/2 top-[44%] -z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-mw-accent/25 blur-3xl"
            style={{ width: 'min(60vw, 720px)', height: 'min(30vw, 360px)' }}
          />
        </>
      ) : (
        <div className="grid h-full place-items-center">
          <Glyph
            className="text-mw-edge/40 drop-shadow-[0_0_60px_rgba(54,166,255,0.25)]"
            style={{ width: 'min(70vw, 620px)', height: 'auto' }}
            strokeWidth={0.6}
          />
        </div>
      )}
      <div className="absolute bottom-[18%] h-px w-2/3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-transparent via-mw-accent/50 to-transparent" />
    </div>
  );
}

function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === 'left' ? 'Previous car' : 'Next car'}
      onClick={onClick}
      className={
        'group absolute top-[42%] z-10 grid h-12 w-12 -translate-y-1/2 place-items-center border border-mw-edge/60 bg-mw-panel/50 text-mw-muted backdrop-blur-sm transition-colors hover:border-mw-accent hover:text-mw-accent ' +
        (side === 'left' ? 'left-3 sm:left-6' : 'right-3 sm:right-6')
      }
    >
      <Icon size={26} strokeWidth={2.5} />
    </button>
  );
}

/** Segmented MW-style meter — lit blue bars fill staggered on car change. */
function Meter({ label, value, readout }: { label: string; value: number; readout: string }) {
  const SEGMENTS = 18;
  const lit = Math.round(clamp01(value) * SEGMENTS);
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-mw-muted">
        <span>{label}</span>
        <span className="text-mw-text">{readout}</span>
      </div>
      <div className="mt-1.5 flex gap-[3px]">
        {Array.from({ length: SEGMENTS }).map((_, idx) => (
          <span
            key={idx}
            className={
              'h-3 flex-1 -skew-x-12 transition-colors duration-300 ' +
              (idx < lit
                ? 'bg-mw-accent shadow-[0_0_8px_rgba(54,166,255,0.5)]'
                : 'bg-mw-steel')
            }
            style={{ transitionDelay: `${idx * 18}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

// ── derivation ─────────────────────────────────────────────────────────────

type Spec = {
  powerHp: number;
  topKmh: number;
  drivetrain: 'AWD' | 'RWD' | 'FWD';
  classLabel: 'Sports' | 'Muscle' | 'All-terrain' | 'Demo';
  gearLabel: string;
  redline: number;
  meters: { power: number; top: number; grip: number; agility: number };
};

/** Turn a manifest (+ optional tuning) into display specs and 0..1 meter fills. */
function deriveSpec(m: VehicleManifest): Spec {
  const powerHp = Math.round(Math.max(...m.engine.powerCurveHpAtRpm.map(([, hp]) => hp)));
  const tonnes = m.mass / 1000;
  const powerToWeight = powerHp / tonnes;
  const topKmh = Math.round(130 + powerToWeight * 0.5);

  const front = m.rig.wheels.filter((w) => w.position[2] > 0);
  const rear = m.rig.wheels.filter((w) => w.position[2] < 0);
  const frontDriven = front.some((w) => w.isDriven);
  const rearDriven = rear.some((w) => w.isDriven);
  const drivetrain: Spec['drivetrain'] =
    frontDriven && rearDriven ? 'AWD' : frontDriven ? 'FWD' : 'RWD';

  const t = m.tuning;
  const gripScale = t?.gripScale ?? 1;
  const steerDeg = t?.maxSteerDeg ?? 32;

  const meters = {
    power: norm(powerToWeight, 150, 310),
    top: norm(topKmh, 170, 330),
    grip: norm(gripScale, 0.9, 1.3),
    agility: clamp01(
      0.55 * norm(4.2 - tonnes, 0.2, 3.0) +
        0.25 * norm(steerDeg, 28, 40) +
        0.2 * norm(gripScale, 0.9, 1.3),
    ),
  };

  const classLabel: Spec['classLabel'] =
    drivetrain === 'AWD' && m.mass > 2500
      ? 'All-terrain'
      : powerToWeight >= 250
        ? 'Sports'
        : m.mass > 1600
          ? 'Muscle'
          : 'Demo';

  const gearLabel =
    m.gearbox.type === 'automatic' && m.gearbox.ratios.length <= 1
      ? 'SINGLE-SPEED'
      : `${m.gearbox.ratios.length}-SPD ${m.gearbox.type.toUpperCase()}`;

  return { powerHp, topKmh, drivetrain, classLabel, gearLabel, redline: m.engine.redline, meters };
}

function pct(v: number): string {
  return `${Math.round(clamp01(v) * 100)}%`;
}
function norm(v: number, lo: number, hi: number): number {
  return clamp01((v - lo) / (hi - lo));
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
