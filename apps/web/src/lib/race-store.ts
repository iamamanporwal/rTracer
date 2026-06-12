/**
 * Local persistence for dev-authored races (the Dev-Mode Race Builder).
 *
 * A race is per-zone: drop a START gate (and a FINISH for sprints), pick a track
 * type, and the layout survives a reload from `localStorage` — no server, same
 * pattern as {@link ./rider-pose-store}. This is a *local* authoring aid (per
 * browser/device); shipping a race to everyone would mean baking it into the
 * zone manifest, which is out of scope here.
 *
 * The payload is tiny (two transforms + a few scalars). It's parsed defensively
 * on read — a malformed or partial blob yields `null` rather than throwing, so a
 * stale save can never break a session boot.
 */

/** Sprint = point-to-point (start far from finish). Loop = start *is* finish. */
export type RaceTrackType = 'sprint' | 'loop';

/** A placed gate: ground position + a yaw-only orientation quaternion. */
export type RaceMarkerData = {
  /** World position of the gate base, seated on the ground. */
  position: [number, number, number];
  /** Orientation quaternion (x, y, z, w) — used for the spawn facing + gate yaw. */
  quat: [number, number, number, number];
};

export type SavedRace = {
  type: RaceTrackType;
  start: RaceMarkerData | null;
  finish: RaceMarkerData | null;
  /** Target laps for a loop race (ignored for sprints). */
  laps: number;
  /** Best completed time in milliseconds, or null if never finished. */
  bestMs: number | null;
};

const keyFor = (zoneId: string): string => `trace.race.${zoneId}`;

export function saveRace(zoneId: string, race: SavedRace): void {
  try {
    localStorage.setItem(keyFor(zoneId), JSON.stringify(race));
  } catch {
    // Storage disabled/full — authoring still works for this session.
  }
}

export function clearRace(zoneId: string): void {
  try {
    localStorage.removeItem(keyFor(zoneId));
  } catch {
    /* ignore */
  }
}

/** Read a saved race, or `null` if absent / unparseable / malformed. */
export function loadRace(zoneId: string): SavedRace | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyFor(zoneId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return null;
    const rec = p as Record<string, unknown>;
    const type: RaceTrackType = rec.type === 'loop' ? 'loop' : 'sprint';
    const laps = typeof rec.laps === 'number' && rec.laps >= 1 ? Math.floor(rec.laps) : 1;
    const bestMs = typeof rec.bestMs === 'number' && rec.bestMs > 0 ? rec.bestMs : null;
    return {
      type,
      start: parseMarker(rec.start),
      finish: parseMarker(rec.finish),
      laps,
      bestMs,
    };
  } catch {
    return null;
  }
}

/** Narrow an unknown blob to a {@link RaceMarkerData}, or `null` if it's bad. */
function parseMarker(v: unknown): RaceMarkerData | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  const pos = m.position;
  const quat = m.quat;
  if (!isVec(pos, 3) || !isVec(quat, 4)) return null;
  return {
    position: [pos[0]!, pos[1]!, pos[2]!],
    quat: [quat[0]!, quat[1]!, quat[2]!, quat[3]!],
  };
}

function isVec(v: unknown, len: number): v is number[] {
  return Array.isArray(v) && v.length === len && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}
