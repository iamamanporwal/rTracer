import type { ReactNode } from 'react';
import { useStore } from '~/store';
import { loadVehicleIndex, loadVehicleManifest, useAsync } from '~/manifests';
import type { VehicleManifest } from '@trace/core';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Gauge, Loader2, TriangleAlert, Weight, Zap } from 'lucide-react';

export function VehicleSelect() {
  const selected = useStore((s) => s.vehicle.selectedVehicle);
  const selectVehicle = useStore((s) => s.vehicle.selectVehicle);
  const zone = useStore((s) => s.zone.selectedZone);

  const index = useAsync(() => loadVehicleIndex(), []);

  return (
    <div className="max-w-5xl mx-auto">
      <header className="flex items-baseline justify-between">
        <h2 className="text-2xl font-semibold">Vehicles</h2>
        <span className="text-xs font-mono text-trace-muted">step 2 of 2</span>
      </header>
      <p className="text-trace-muted mt-1">
        Pick what to drive. Each car has its own weight, power, grip, and sound — they feel
        different the moment you touch the throttle.
      </p>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {index.status === 'loading' &&
          [0, 1, 2].map((i) => (
            <div key={i} className="h-56 rounded-2xl border border-trace-line/50 animate-pulse" />
          ))}
        {index.status === 'error' && (
          <div className="sm:col-span-2 rounded-xl border border-red-500/40 bg-red-500/5 p-5 text-sm text-red-300">
            <TriangleAlert size={14} className="inline mr-2" />
            {index.error.message}
          </div>
        )}
        {index.status === 'ready' &&
          index.value.map((entry) => (
            <VehicleCard
              key={`${entry.id}:${entry.version}`}
              id={entry.id}
              version={entry.version}
              isSelected={selected?.id === entry.id && selected.version === entry.version}
              onPick={() => selectVehicle(entry)}
            />
          ))}
      </div>

      {selected && (
        <div className="mt-10 flex items-center justify-between rounded-xl border border-trace-line p-5">
          <div>
            <div className="text-xs font-mono text-trace-muted">selected</div>
            <div className="mt-1 font-medium">{selected.id}</div>
          </div>
          <Link
            to={zone ? '/ready' : '/zones'}
            className="inline-flex items-center gap-2 rounded-lg bg-trace-accent px-4 py-2 text-sm font-medium text-black"
          >
            {zone ? 'Ready to drive' : 'Pick zone'}
            <ArrowRight size={16} />
          </Link>
        </div>
      )}
    </div>
  );
}

function VehicleCard(props: {
  id: string;
  version: string;
  isSelected: boolean;
  onPick: () => void;
}) {
  const manifest = useAsync<VehicleManifest>(
    () => loadVehicleManifest(props.id, props.version),
    [props.id, props.version],
  );

  return (
    <button
      type="button"
      onClick={props.onPick}
      className={
        'group text-left rounded-2xl border p-5 transition-colors ' +
        (props.isSelected
          ? 'border-trace-accent bg-trace-accent/5'
          : 'border-trace-line hover:border-trace-accent/70')
      }
    >
      {manifest.status === 'ready' ? (
        <CardBody m={manifest.value} selected={props.isSelected} />
      ) : manifest.status === 'error' ? (
        <div className="text-sm text-red-400">
          <TriangleAlert size={14} className="inline mr-1" />
          {manifest.error.message}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-trace-muted">
          <Loader2 size={14} className="animate-spin" />
          <span className="font-mono text-xs">{props.id}</span>
        </div>
      )}
    </button>
  );
}

function CardBody({ m, selected }: { m: VehicleManifest; selected: boolean }) {
  const s = computeSpecs(m);
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold leading-tight">{m.displayName}</div>
          <div className="mt-0.5 text-xs font-mono text-trace-muted">{s.classLabel}</div>
        </div>
        <span
          className={
            'shrink-0 rounded-md px-2 py-1 text-[10px] font-mono font-medium tracking-wide ' +
            (selected ? 'bg-trace-accent text-black' : 'bg-trace-line/40 text-trace-muted')
          }
        >
          {s.drivetrain}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Stat icon={<Zap size={13} />} label="power" value={`${s.powerHp}`} unit="hp" />
        <Stat icon={<Weight size={13} />} label="weight" value={`${(m.mass / 1000).toFixed(2)}`} unit="t" />
        <Stat
          icon={<Gauge size={13} />}
          label="hp / ton"
          value={`${s.powerToWeight}`}
          unit=""
        />
      </div>

      <div className="mt-4 space-y-1.5">
        <Bar label="Power" value={s.ratings.power} />
        <Bar label="Braking" value={s.ratings.braking} />
        <Bar label="Grip" value={s.ratings.grip} />
        <Bar label="Agility" value={s.ratings.agility} />
      </div>

      <div className="mt-4 flex items-center justify-between text-[11px] font-mono text-trace-muted">
        <span>
          {m.gearbox.type === 'automatic' && m.gearbox.ratios.length <= 1
            ? 'single-speed'
            : `${m.gearbox.ratios.length}-speed ${m.gearbox.type}`}
        </span>
        <span>{m.engine.redline.toLocaleString()} rpm</span>
      </div>
    </>
  );
}

function Stat(props: { icon: ReactNode; label: string; value: string; unit: string }) {
  return (
    <div className="rounded-lg border border-trace-line/60 bg-trace-line/10 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-trace-muted">
        {props.icon}
        {props.label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-trace-fg">
        {props.value}
        <span className="ml-0.5 text-[10px] text-trace-muted">{props.unit}</span>
      </div>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-trace-muted">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-trace-line/40">
        <div
          className="h-full rounded-full bg-trace-accent transition-[width] group-hover:opacity-90"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

type Specs = {
  powerHp: number;
  powerToWeight: number;
  drivetrain: 'AWD' | 'RWD' | 'FWD';
  classLabel: string;
  ratings: { power: number; braking: number; grip: number; agility: number };
};

/** Derive display specs + 0..1 rating bars from a manifest (incl. tuning). */
function computeSpecs(m: VehicleManifest): Specs {
  const powerHp = Math.round(Math.max(...m.engine.powerCurveHpAtRpm.map(([, hp]) => hp)));
  const tonnes = m.mass / 1000;
  const powerToWeight = Math.round(powerHp / tonnes);

  const front = m.rig.wheels.filter((w) => w.position[2] > 0);
  const rear = m.rig.wheels.filter((w) => w.position[2] < 0);
  const frontDriven = front.some((w) => w.isDriven);
  const rearDriven = rear.some((w) => w.isDriven);
  const drivetrain: Specs['drivetrain'] =
    frontDriven && rearDriven ? 'AWD' : frontDriven ? 'FWD' : 'RWD';

  const t = m.tuning;
  const brakeG = t?.brakeDecelG ?? 0.82;
  const gripScale = t?.gripScale ?? 1;
  const steerDeg = t?.maxSteerDeg ?? 32;

  // Agility: light + grippy + lots of steering lock turns in; heavy cars feel
  // ponderous. Inverse weight dominates, steering lock and grip help.
  const ratings = {
    power: norm(powerToWeight, 150, 310),
    braking: norm(brakeG, 0.6, 1.1),
    grip: norm(gripScale, 0.9, 1.3),
    agility: clamp01(
      0.55 * norm(4.2 - tonnes, 0.2, 3.0) +
        0.25 * norm(steerDeg, 28, 40) +
        0.2 * norm(gripScale, 0.9, 1.3),
    ),
  };

  const classLabel =
    drivetrain === 'AWD' && m.mass > 2500
      ? 'All-terrain'
      : powerToWeight >= 250
        ? 'Sports'
        : m.mass > 1600
          ? 'Muscle'
          : 'Demo';

  return { powerHp, powerToWeight, drivetrain, classLabel, ratings };
}

function norm(v: number, lo: number, hi: number): number {
  return clamp01((v - lo) / (hi - lo));
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
