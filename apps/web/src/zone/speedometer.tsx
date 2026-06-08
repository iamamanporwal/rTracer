import { useMemo } from 'react';

/**
 * Analog sweep speedometer for the game HUD.
 *
 * A 270° dial (gap at the bottom) with tick marks, numeric labels, a red
 * redline zone near the top, an accent "progress" arc that fills with speed,
 * and a needle. The km/h number is repeated digitally in the centre.
 *
 * Pure presentational: feed it `kmh` and a pixel `size`. The dial range is a
 * fixed 0–`max` (real car clusters use a fixed dial regardless of the car's
 * true top speed), so the same gauge reads sensibly for every vehicle.
 *
 * Only the needle + progress arc + digits change per frame; the static dial
 * (track, ticks, labels, redline) is memoised so the per-frame cost is a single
 * `Math` pair for the needle.
 */
export function Speedometer({
  kmh,
  size = 190,
  max = 300,
  redlineFrom = 240,
}: {
  kmh: number;
  size?: number;
  max?: number;
  redlineFrom?: number;
}) {
  const clamped = Math.max(0, Math.min(max, kmh));
  const angle = valueToAngle(clamped, max);
  const needle = polar(CX, CY, NEEDLE_LEN, angle);

  // Static dial — only depends on the geometry props, not on the live speed.
  const dial = useMemo(() => buildDial(max, redlineFrom), [max, redlineFrom]);

  return (
    <div className="relative select-none" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        className="block drop-shadow-[0_4px_24px_rgba(0,0,0,0.55)]"
        aria-hidden
      >
        {/* Dial face */}
        <circle cx={CX} cy={CY} r={96} className="fill-black/45" />
        <circle cx={CX} cy={CY} r={96} className="fill-none stroke-mw-edge/60" strokeWidth={1.5} />

        {dial}

        {/* Progress arc — fills the track up to the current speed. */}
        {clamped > 0 && (
          <path
            d={arcPath(TRACK_R, valueToAngle(0, max), angle)}
            className="fill-none stroke-mw-accent"
            strokeWidth={6}
            strokeLinecap="round"
          />
        )}

        {/* Needle + hub */}
        <line
          x1={CX}
          y1={CY}
          x2={needle.x}
          y2={needle.y}
          className="stroke-mw-hot"
          strokeWidth={3}
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r={7} className="fill-mw-steel stroke-mw-hot" strokeWidth={2} />
      </svg>

      {/* Digital readout — an HTML overlay (not SVG <text>) so it renders crisply
          and stays readable via `innerText` for the E2E speed assertions. Sits in
          the lower portion of the dial, inside the bottom gap. */}
      <div
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center"
        style={{ top: '62%' }}
      >
        <span
          data-testid="hud-speed-kmh"
          className="font-mono font-bold leading-none text-mw-text"
          style={{ fontSize: size * 0.16 }}
        >
          {clamped.toFixed(0)}
        </span>
        <span
          className="font-mono uppercase text-mw-muted"
          style={{ fontSize: size * 0.058, letterSpacing: 2 }}
        >
          KM/H
        </span>
      </div>
    </div>
  );
}

// ── Dial geometry ────────────────────────────────────────────────────────────
// 200×200 viewBox. The dial sweeps 270° clockwise (y-down coords): value 0 sits
// at the lower-left (135°) and `max` at the lower-right (405° ≡ 45°), leaving a
// 90° gap at the bottom for the digital readout.

const CX = 100;
const CY = 100;
const TRACK_R = 84;
const TICK_OUTER = 88;
const TICK_MAJOR_INNER = 74;
const TICK_MINOR_INNER = 80;
const LABEL_R = 62;
const NEEDLE_LEN = 64;
const START_ANGLE = 135;
const SWEEP = 270;

function valueToAngle(v: number, max: number): number {
  return START_ANGLE + (v / max) * SWEEP;
}

function polar(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** SVG arc path from `a0`→`a1` (degrees, clockwise) at radius `r`. */
function arcPath(r: number, a0: number, a1: number): string {
  const start = polar(CX, CY, r, a0);
  const end = polar(CX, CY, r, a1);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/** Build the static dial elements (track, redline, ticks, labels). */
function buildDial(max: number, redlineFrom: number) {
  const ticks: JSX.Element[] = [];
  const labels: JSX.Element[] = [];
  const minorStep = 20;
  const labelStep = 40;

  for (let v = 0; v <= max; v += minorStep) {
    const a = valueToAngle(v, max);
    const major = v % labelStep === 0;
    const inner = major ? TICK_MAJOR_INNER : TICK_MINOR_INNER;
    const p1 = polar(CX, CY, inner, a);
    const p2 = polar(CX, CY, TICK_OUTER, a);
    const hot = v >= redlineFrom;
    ticks.push(
      <line
        key={`t${v}`}
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        className={hot ? 'stroke-mw-hot' : 'stroke-mw-muted/80'}
        strokeWidth={major ? 2 : 1}
      />,
    );
    if (major) {
      const lp = polar(CX, CY, LABEL_R, a);
      labels.push(
        <text
          key={`l${v}`}
          x={lp.x}
          y={lp.y}
          textAnchor="middle"
          dominantBaseline="central"
          className={hot ? 'fill-mw-hot' : 'fill-mw-muted'}
          style={{ fontSize: 9 }}
        >
          {v}
        </text>,
      );
    }
  }

  return (
    <>
      {/* Base track */}
      <path
        d={arcPath(TRACK_R, valueToAngle(0, max), valueToAngle(max, max))}
        className="fill-none stroke-mw-edge"
        strokeWidth={6}
        strokeLinecap="round"
      />
      {/* Redline zone */}
      <path
        d={arcPath(TRACK_R, valueToAngle(redlineFrom, max), valueToAngle(max, max))}
        className="fill-none stroke-mw-hot/70"
        strokeWidth={6}
        strokeLinecap="round"
      />
      {ticks}
      {labels}
    </>
  );
}
