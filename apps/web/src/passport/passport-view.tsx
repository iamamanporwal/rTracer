import { useStore } from '~/store';

export function PassportView() {
  const snapshot = useStore((s) => s.passport.snapshot);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-semibold">Passport</h2>
      <p className="text-trace-muted mt-1">
        Phase 0 placeholder. Real stamps + best laps land at Phase 1 Week 10.
      </p>
      <div className="mt-8 rounded-xl border border-trace-line bg-black/30 p-5">
        <div className="text-xs font-mono text-trace-muted">passport</div>
        <div className="mt-1 font-medium">
          {snapshot.displayName ?? <span className="text-trace-muted">— unset —</span>}
        </div>
        <div className="mt-4 text-sm text-trace-muted">
          {snapshot.stamps.length === 0 ? 'No stamps yet.' : `${snapshot.stamps.length} stamps`}
        </div>
      </div>
    </div>
  );
}
