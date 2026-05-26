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

  it('selectZone updates zone slice with id+version ref', () => {
    useStore.getState().zone.selectZone({ id: 'zone_alpha', version: '0.1.0' });
    expect(useStore.getState().zone.selectedZone?.id).toBe('zone_alpha');
    expect(useStore.getState().zone.selectedZone?.version).toBe('0.1.0');
    useStore.getState().zone.selectZone(null);
    expect(useStore.getState().zone.selectedZone).toBeNull();
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
