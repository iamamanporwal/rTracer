import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronLeft,
  ChevronRight,
  Map as MapIcon,
  Flag,
  Loader2,
  TriangleAlert,
  Check,
} from 'lucide-react';
import type { ZoneManifest } from '@trace/core';
import { useStore } from '~/store';
import { loadZoneIndex, loadZoneManifest, useAsync } from '~/manifests';
import { useIsTouch } from '~/lib/use-device';
import type { ManifestRef } from '~/store';

/**
 * Game-mode Map / Track Select — the player-facing track changer.
 *
 * A sibling of the Garage (`game/garage`): same "Need for Speed: Most Wanted"
 * cold-blue shell, left/right carousel, segmented stat meters, and a thumbnail
 * strip — but over zone manifests instead of vehicles. Picking a track stores it
 * in the zone slice and returns to the Garage, where DRIVE launches the chosen
 * track. (Drive-now is also one click away here.)
 */

type Loaded = { ref: ManifestRef; manifest: ZoneManifest };

export function MapSelect() {
  const data = useAsync<Loaded[]>(async () => {
    const index = await loadZoneIndex();
    const settled = await Promise.allSettled(
      index.map(async (ref) => ({
        ref: ref as ManifestRef,
        manifest: await loadZoneManifest(ref.id, ref.version),
      })),
    );
    const ok = settled.filter((s): s is PromiseFulfilledResult<Loaded> => s.status === 'fulfilled');
    if (ok.length === 0) throw new Error('No tracks could be loaded.');
    return ok.map((s) => s.value);
  }, []);

  if (data.status === 'ready') return <MapStage tracks={data.value} />;

  return (
    <Shell>
      <div className="grid h-full place-items-center">
        {data.status === 'error' ? (
          <div className="text-center text-mw-muted">
            <TriangleAlert className="mx-auto mb-3 text-mw-hot" size={28} />
            <div className="font-display text-2xl uppercase tracking-wide text-mw-text">
              Tracks unavailable
            </div>
            <p className="mt-1 font-mono text-xs">{data.error.message}</p>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-mw-muted">
            <Loader2 className="animate-spin text-mw-accent" size={18} />
            <span className="font-mono text-xs uppercase tracking-[0.3em]">Loading tracks…</span>
          </div>
        )}
      </div>
    </Shell>
  );
}

function MapStage({ tracks }: { tracks: Loaded[] }) {
  const navigate = useNavigate();
  const selectZone = useStore((s) => s.zone.selectZone);
  const selectedZone = useStore((s) => s.zone.selectedZone);
  const selectedVehicle = useStore((s) => s.vehicle.selectedVehicle);
  // Touch screens are short and wide (locked landscape); the full stat panel
  // overflows and hides the CTAs there, so on touch we keep just the track name
  // and the action buttons — mirroring the Garage.
  const isTouch = useIsTouch();

  // Open on the currently-selected track if there is one.
  const initial = Math.max(
    0,
    tracks.findIndex((t) => t.ref.id === selectedZone?.id),
  );
  const [i, setI] = useState(initial);
  const total = tracks.length;
  const current = tracks[i];
  const spec = useMemo(() => (current ? deriveSpec(current.manifest) : null), [current]);

  const next = () => setI((p) => (p + 1) % total);
  const prev = () => setI((p) => (p - 1 + total) % total);

  /** Confirm the track and head back to the Garage to pick a car / drive. */
  function select() {
    if (!current) return;
    selectZone(current.ref);
    void navigate({ to: '/' });
  }

  /** Skip the Garage: confirm the track and drop straight into the session. */
  function driveNow() {
    if (!current) return;
    selectZone(current.ref);
    void navigate({ to: '/play/$zoneId', params: { zoneId: current.ref.id } });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'Enter') select();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, current?.ref.id, selectedVehicle?.id]);

  if (!current || !spec) return null;
  const isSelected = selectedZone?.id === current.ref.id;

  return (
    <Shell>
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-6 pt-6 sm:px-10">
        <div className="flex items-center gap-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.4em] text-mw-muted">
            TRACE <span className="text-mw-accent">{'// Tracks'}</span>
          </div>
          <nav className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.3em]">
            <Link to="/" className="text-mw-muted transition-colors hover:text-mw-accent">
              Cars
            </Link>
            <span className="text-mw-edge">·</span>
            <span className="text-mw-text">Tracks</span>
          </nav>
        </div>
        <div className="font-display text-sm tracking-[0.3em] text-mw-muted">
          <span className="text-mw-text">{String(i + 1).padStart(2, '0')}</span> /{' '}
          {String(total).padStart(2, '0')}
        </div>
      </header>

      {/* Stage */}
      <main className="relative flex-1">
        <HeroArt key={`art-${current.ref.id}`} fidelity={current.manifest.fidelityTier} />

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
              {!isTouch && (
                <div className="flex items-center gap-3 font-display text-sm uppercase tracking-[0.35em] text-mw-accent">
                  <span className="h-2 w-2 -skew-x-12 bg-mw-accent" />
                  {spec.profileLabel}
                  {isSelected && (
                    <span className="inline-flex items-center gap-1 text-mw-text">
                      <Check size={14} strokeWidth={3} /> Selected
                    </span>
                  )}
                </div>
              )}
              <h1
                className={
                  isTouch
                    ? 'font-display text-3xl font-bold uppercase leading-[0.95] tracking-tight text-mw-text sm:text-4xl'
                    : 'mt-2 font-display text-5xl font-bold uppercase leading-[0.9] tracking-tight text-mw-text sm:text-6xl lg:text-7xl xl:text-8xl'
                }
              >
                {current.manifest.name}
              </h1>
              {!isTouch && (
                <div className="mt-3 font-mono text-xs uppercase tracking-[0.25em] text-mw-muted">
                  {spec.controlLabel} · {spec.fidelityLabel} · {spec.modeLabel}
                </div>
              )}

              <div className={(isTouch ? 'mt-4' : 'mt-7') + ' flex flex-wrap items-center gap-3'}>
                <button
                  type="button"
                  onClick={select}
                  className="group inline-flex -skew-x-12 items-center gap-3 bg-mw-accent px-9 py-3.5 shadow-[0_0_34px_rgba(54,166,255,0.45)] transition-colors hover:bg-white"
                >
                  <span className="skew-x-12 font-display text-xl font-bold uppercase tracking-[0.2em] text-mw-bg">
                    Select Track
                  </span>
                  <ChevronRight className="skew-x-12 text-mw-bg" size={22} strokeWidth={3} />
                </button>
                <button
                  type="button"
                  onClick={driveNow}
                  className="inline-flex -skew-x-12 items-center gap-2 border border-mw-edge/60 bg-mw-panel/60 px-6 py-3.5 text-mw-muted backdrop-blur-sm transition-colors hover:border-mw-accent hover:text-mw-accent"
                >
                  <span className="skew-x-12 font-display text-sm font-semibold uppercase tracking-[0.2em]">
                    Drive Now
                  </span>
                </button>
              </div>
            </div>

            {/* Stat panel — desktop only; too tall for a phone's landscape
                viewport and would bury the CTAs. */}
            {!isTouch && (
              <div className="w-full -skew-x-6 border border-mw-edge/60 bg-mw-panel/70 p-5 backdrop-blur-sm lg:w-[22rem]">
                <div className="skew-x-6 space-y-3.5">
                  <Meter label="Grip" value={spec.meters.grip} readout={pct(spec.meters.grip)} />
                  <Meter label="Technical" value={spec.meters.technical} readout={pct(spec.meters.technical)} />
                  <Meter label="Detail" value={spec.meters.detail} readout={spec.fidelityLabel} />
                  <Meter label="Slip" value={spec.meters.slip} readout={pct(spec.meters.slip)} />
                  <div className="flex items-center justify-between border-t border-mw-edge/50 pt-3 font-mono text-[11px] uppercase tracking-wider text-mw-muted">
                    <span>Spawns</span>
                    <span className="text-mw-text">{current.manifest.spawnPoints.length}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Thumbnail strip */}
      <footer className="relative z-10 border-t border-mw-edge/40 bg-mw-bg/60 px-6 py-4 backdrop-blur-sm sm:px-10">
        <div className="mx-auto flex max-w-6xl gap-2.5 overflow-x-auto">
          {tracks.map((t, idx) => (
            <button
              key={t.ref.id}
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
                {t.manifest.name}
              </span>
            </button>
          ))}
        </div>
      </footer>

      {!isTouch && (
        <Link
          to="/dev"
          className="absolute bottom-1.5 right-3 z-20 font-mono text-[10px] uppercase tracking-[0.3em] text-mw-muted/40 transition-colors hover:text-mw-accent"
        >
          dev
        </Link>
      )}
    </Shell>
  );
}

/** Full-screen MW backdrop — identical to the Garage shell. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-mw-bg font-display text-mw-text">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(54,166,255,0.16),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background:repeating-linear-gradient(115deg,transparent_0,transparent_38px,#36a6ff_38px,#36a6ff_40px)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.85))]" />
      {children}
    </div>
  );
}

/**
 * Hero art layer. Tracks ship without preview renders yet, so we draw a stylized
 * map/route glyph (mirrors the Garage's car silhouette fallback) tinted into the
 * Most-Wanted cold-blue palette.
 */
function HeroArt({ fidelity }: { fidelity: ZoneManifest['fidelityTier'] }) {
  const Glyph = fidelity === 'high' ? MapIcon : Flag;
  return (
    <div className="mw-fade pointer-events-none absolute inset-0">
      <div className="grid h-full place-items-center">
        <Glyph
          className="text-mw-edge/40 drop-shadow-[0_0_60px_rgba(54,166,255,0.25)]"
          style={{ width: 'min(52vw, 460px)', height: 'auto' }}
          strokeWidth={0.6}
        />
      </div>
      <div
        className="absolute left-1/2 top-[44%] -z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-mw-accent/20 blur-3xl"
        style={{ width: 'min(60vw, 720px)', height: 'min(30vw, 360px)' }}
      />
      <div className="absolute bottom-[18%] h-px w-2/3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-transparent via-mw-accent/50 to-transparent" />
    </div>
  );
}

function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === 'left' ? 'Previous track' : 'Next track'}
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

/** Segmented MW-style meter — identical to the Garage's. */
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
              (idx < lit ? 'bg-mw-accent shadow-[0_0_8px_rgba(54,166,255,0.5)]' : 'bg-mw-steel')
            }
            style={{ transitionDelay: `${idx * 18}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

// ── derivation ─────────────────────────────────────────────────────────────

type ZoneSpec = {
  profileLabel: string;
  controlLabel: string;
  fidelityLabel: string;
  modeLabel: string;
  meters: { grip: number; technical: number; detail: number; slip: number };
};

/** Turn a zone manifest into MW-style display labels + 0..1 meter fills. */
function deriveSpec(m: ZoneManifest): ZoneSpec {
  const profileLabel = {
    tarmac_circuit: 'Circuit · Tarmac',
    dirt: 'Rally · Dirt',
    snow: 'Ice · Snow',
    drift: 'Drift · Tarmac',
  }[m.physicsProfile];

  const controlLabel = `${m.controlScheme.toUpperCase()} feel`;
  const fidelityLabel = m.fidelityTier.toUpperCase();
  const modeLabel = m.modesSupported.map((x) => x.replace('_', ' ')).join(' · ');

  // Cosmetic meters derived from the profile + fidelity. Grip/Slip are inverse
  // sides of the same surface: a drift profile is low-grip / high-slip.
  const grip = { tarmac_circuit: 0.95, drift: 0.65, dirt: 0.55, snow: 0.3 }[m.physicsProfile];
  const slip = 1 - grip;
  const technical = { circuit: 0.7, drift: 0.9, rally: 0.8, casual: 0.4 }[m.controlScheme];
  const detail = { low: 0.33, medium: 0.66, high: 1 }[m.fidelityTier];

  return {
    profileLabel,
    controlLabel,
    fidelityLabel,
    modeLabel,
    meters: { grip, technical, detail, slip },
  };
}

function pct(v: number): string {
  return `${Math.round(clamp01(v) * 100)}%`;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
