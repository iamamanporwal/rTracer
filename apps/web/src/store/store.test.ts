import { describe, expect, it } from 'vitest';
import { useStore } from './index';

describe('root store', () => {
  it('has the six slices from blueprint §5.4', () => {
    const state = useStore.getState();
    expect(state.zone).toBeDefined();
    expect(state.vehicle).toBeDefined();
    expect(state.session).toBeDefined();
    expect(state.passport).toBeDefined();
    expect(state.ui).toBeDefined();
    expect(state.editor).toBeDefined();
  });

  it('selectZone updates zone slice', () => {
    useStore.getState().zone.selectZone('zone_demo');
    expect(useStore.getState().zone.selectedZoneId).toBe('zone_demo');
    useStore.getState().zone.selectZone(null);
  });

  it('awardStamp appends to passport snapshot', () => {
    const before = useStore.getState().passport.snapshot.stamps.length;
    useStore.getState().passport.awardStamp({
      id: 'stamp_test',
      source: 'zone_visit',
      zoneId: 'zone_demo',
      earnedAt: Date.now(),
    });
    expect(useStore.getState().passport.snapshot.stamps.length).toBe(before + 1);
  });
});
