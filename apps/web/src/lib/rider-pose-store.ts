/**
 * Local persistence for authored rider pose sets.
 *
 * The dev pose editor and the game run on the same origin, so a pose saved in
 * the editor is read straight back by the running game from `localStorage` — no
 * server, no file write. This is a *local* override (per browser/device): the
 * Save button makes a pose take effect in-game immediately for iteration. To ship
 * a pose to everyone, use the editor's Export and commit the JSON into the
 * vehicle manifest instead.
 *
 * The payload is a {@link RiderPoseSet} (a few KB); it's migrated on read so older
 * saves (single `legPole`) still load.
 */
import {
  DEFAULT_RIDE_POSE,
  clonePose,
  RIDER_POSE_NAMES,
  type RiderPose,
  type RiderPoseName,
  type RiderPoseSet,
} from '@trace/renderer';

const keyFor = (vehicleId: string): string => `trace.riderPoses.${vehicleId}`;

export function saveRiderPoseSet(vehicleId: string, set: RiderPoseSet): void {
  try {
    localStorage.setItem(keyFor(vehicleId), JSON.stringify(set));
  } catch {
    // Storage disabled/full — saving is best-effort; the editor still works.
  }
}

export function clearRiderPoseSet(vehicleId: string): void {
  try {
    localStorage.removeItem(keyFor(vehicleId));
  } catch {
    /* ignore */
  }
}

/** Read a saved set, filling any missing fields from the default sport tuck. */
export function loadRiderPoseSet(vehicleId: string): RiderPoseSet | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyFor(vehicleId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<RiderPoseName, unknown>>;
    const out = {} as RiderPoseSet;
    for (const name of RIDER_POSE_NAMES) {
      out[name] = { ...clonePose(DEFAULT_RIDE_POSE), ...migrateRiderPose(parsed[name]) };
    }
    return out;
  } catch {
    return null;
  }
}

/** Back-compat: an old pose carrying a single `legPole` → per-side `legPoleL/R`. */
export function migrateRiderPose(p: unknown): Partial<RiderPose> | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const rec = p as Record<string, unknown> & { legPole?: [number, number, number] };
  if (Array.isArray(rec.legPole) && !rec.legPoleL && !rec.legPoleR) {
    const { legPole, ...rest } = rec;
    return { ...(rest as Partial<RiderPose>), legPoleL: [...legPole], legPoleR: [...legPole] };
  }
  return rec as Partial<RiderPose>;
}
