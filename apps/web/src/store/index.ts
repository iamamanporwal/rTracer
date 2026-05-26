import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  EditorMode,
  EditorSlice,
  LapRecord,
  PassportSlice,
  PassportSnapshot,
  RootStore,
  SessionSlice,
  SessionStatus,
  Stamp,
  UIRoute,
  UISlice,
  VehicleSlice,
  ZoneLoadStatus,
  ZoneSlice,
} from './types';

const initialZone = (set: ZustandSetter): ZoneSlice => ({
  selectedZoneId: null,
  loadStatus: { phase: 'idle' },
  selectZone: (id) =>
    set((s) => {
      s.zone.selectedZoneId = id;
    }),
  setLoadStatus: (status) =>
    set((s) => {
      s.zone.loadStatus = status;
    }),
});

const initialVehicle = (set: ZustandSetter): VehicleSlice => ({
  selectedVehicleId: null,
  liveryColor: '#ffd84a',
  selectVehicle: (id) =>
    set((s) => {
      s.vehicle.selectedVehicleId = id;
    }),
  setLiveryColor: (hex) =>
    set((s) => {
      s.vehicle.liveryColor = hex;
    }),
});

const initialSession = (set: ZustandSetter): SessionSlice => ({
  status: 'idle',
  currentLapMs: null,
  bestLap: null,
  history: [],
  setStatus: (status: SessionStatus) =>
    set((s) => {
      s.session.status = status;
    }),
  recordLap: (lap: LapRecord) =>
    set((s) => {
      s.session.history.push(lap);
      if (!s.session.bestLap || lap.lapMs < s.session.bestLap.lapMs) {
        s.session.bestLap = lap;
      }
    }),
});

const initialPassport = (set: ZustandSetter): PassportSlice => ({
  snapshot: {
    id: null,
    displayName: null,
    createdAt: null,
    stamps: [],
  },
  hydrate: (snap: PassportSnapshot) =>
    set((s) => {
      s.passport.snapshot = snap;
    }),
  awardStamp: (stamp: Stamp) =>
    set((s) => {
      s.passport.snapshot.stamps.push(stamp);
    }),
});

const initialUI = (set: ZustandSetter): UISlice => ({
  route: 'hub',
  modal: 'none',
  setRoute: (r: UIRoute) =>
    set((s) => {
      s.ui.route = r;
    }),
  setModal: (m) =>
    set((s) => {
      s.ui.modal = m;
    }),
});

const initialEditor = (set: ZustandSetter): EditorSlice => ({
  enabled: false,
  mode: 'view',
  setEnabled: (b) =>
    set((s) => {
      s.editor.enabled = b;
    }),
  setMode: (m: EditorMode) =>
    set((s) => {
      s.editor.mode = m;
    }),
});

type ZustandSetter = (recipe: (state: RootStore) => void) => void;

export const useStore = create<RootStore>()(
  immer((set) => ({
    zone: initialZone(set),
    vehicle: initialVehicle(set),
    session: initialSession(set),
    passport: initialPassport(set),
    ui: initialUI(set),
    editor: initialEditor(set),
  })),
);

export type {
  RootStore,
  ZoneSlice,
  VehicleSlice,
  SessionSlice,
  PassportSlice,
  UISlice,
  EditorSlice,
  ZoneLoadStatus,
};
