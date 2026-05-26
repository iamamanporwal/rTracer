/**
 * Store types per blueprint §5.4. Each slice owns UI-facing state only —
 * hot per-frame data lives in module-local memory inside the canvas runtime.
 */

export type ZoneLoadStatus =
  | { phase: 'idle' }
  | { phase: 'fetching-manifest' }
  | { phase: 'fetching-assets'; progress: number }
  | { phase: 'building'; progress: number }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };

export type ManifestRef = { id: string; version: string };

export type ZoneSlice = {
  selectedZone: ManifestRef | null;
  loadStatus: ZoneLoadStatus;
  selectZone: (ref: ManifestRef | null) => void;
  setLoadStatus: (s: ZoneLoadStatus) => void;
};

export type VehicleSlice = {
  selectedVehicle: ManifestRef | null;
  liveryColor: `#${string}`;
  selectVehicle: (ref: ManifestRef | null) => void;
  setLiveryColor: (hex: `#${string}`) => void;
};

export type SessionStatus = 'idle' | 'driving' | 'completed';

export type LapRecord = {
  zoneId: string;
  vehicleId: string;
  lapMs: number;
  setAt: number;
};

export type SessionSlice = {
  status: SessionStatus;
  currentLapMs: number | null;
  bestLap: LapRecord | null;
  history: LapRecord[];
  setStatus: (s: SessionStatus) => void;
  recordLap: (lap: LapRecord) => void;
};

export type Stamp = {
  id: string;
  source: 'zone_visit' | 'timed_run' | 'first_crash';
  zoneId: string | null;
  earnedAt: number;
  metadata?: unknown;
};

export type PassportSnapshot = {
  id: string | null;
  displayName: string | null;
  createdAt: number | null;
  stamps: Stamp[];
};

export type PassportSlice = {
  snapshot: PassportSnapshot;
  hydrate: (snap: PassportSnapshot) => void;
  awardStamp: (stamp: Stamp) => void;
};

export type UIRoute = 'hub' | 'zones' | 'vehicles' | 'passport' | 'play';

export type UISlice = {
  route: UIRoute;
  modal: 'none' | 'displayName' | 'about';
  setRoute: (r: UIRoute) => void;
  setModal: (m: UISlice['modal']) => void;
};

export type EditorMode = 'view' | 'centerline' | 'barriers' | 'startFinish' | 'spawn';

export type EditorSlice = {
  enabled: boolean;
  mode: EditorMode;
  setEnabled: (b: boolean) => void;
  setMode: (m: EditorMode) => void;
};

export type RootStore = {
  zone: ZoneSlice;
  vehicle: VehicleSlice;
  session: SessionSlice;
  passport: PassportSlice;
  ui: UISlice;
  editor: EditorSlice;
};
