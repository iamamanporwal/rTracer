/**
 * Pose editor — React panel (dev-only, loaded by `/pose-editor.html`).
 *
 * Owns the full-window canvas and a styled side panel; all the 3D work lives in
 * the framework-free {@link createPoseEditorEngine}. The panel sends commands to
 * the engine and re-renders from the engine's {@link EditorState} (a clone — the
 * panel never mutates the rig).
 *
 * Phase-1 UX (vs. the old 42-slider lil-gui wall): pick a *pose state*, pick a
 * *target* (hands / feet / elbows / knees / hips) and edit only that target —
 * drag its gizmo in 3D or nudge its three numbers. Torso/feet tuning is tucked
 * into collapsible sections. Elbows/knees are pole handles: drag to aim the bend.
 *
 * URL params: `?v=vehicle_jawa&hub=-0.179` (hub defaults per bike).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  RIDER_POSE_NAMES,
  type RiderPose,
  type RiderPoseName,
  type RiderPoseSet,
} from '@trace/renderer';
import { loadRiderPoseSet, saveRiderPoseSet } from '~/lib/rider-pose-store';
import {
  createPoseEditorEngine,
  defaultHub,
  TARGET_LIST,
  type EditorState,
  type PoseEditorEngine,
} from './pose-editor-engine';

const SPINE_BONES: { field: keyof RiderPose; label: string }[] = [
  { field: 'spine', label: 'Spine (lower)' },
  { field: 'spine1', label: 'Spine (mid)' },
  { field: 'spine2', label: 'Spine (upper)' },
  { field: 'neck', label: 'Neck' },
  { field: 'head', label: 'Head' },
];
const GROUP_ORDER = ['Body', 'Hands', 'Elbows', 'Feet', 'Knees'];

export function PoseEditorApp(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PoseEditorEngine | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [io, setIo] = useState<'none' | 'export' | 'import'>('none');
  const [ioText, setIoText] = useState('');
  const [savedAt, setSavedAt] = useState(0); // bumps on save → shows the "saved" flash

  const { vehicleId, hub } = useMemo(() => {
    const p = new URLSearchParams(location.search);
    const v = p.get('v') ?? 'vehicle_bike';
    return { vehicleId: v, hub: p.has('hub') ? Number(p.get('hub')) : defaultHub(v) };
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const engine = createPoseEditorEngine({ canvas: canvasRef.current, vehicleId, hub });
    engineRef.current = engine;
    engine.onChange(setState);
    // Re-open with whatever was last saved for this bike (local override).
    const saved = loadRiderPoseSet(vehicleId);
    if (saved) engine.loadPoseSet(saved);
    return () => engine.dispose();
  }, [vehicleId, hub]);

  const saveToGame = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    saveRiderPoseSet(vehicleId, JSON.parse(engine.poseSetJson()) as RiderPoseSet);
    setSavedAt(Date.now());
  };

  const engine = engineRef.current;
  const selected = state ? TARGET_LIST.find((t) => t.id === state.target) ?? TARGET_LIST[0] : null;
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof TARGET_LIST[number][]>();
    for (const t of TARGET_LIST) (byGroup.get(t.group) ?? byGroup.set(t.group, []).get(t.group)!).push(t);
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, []);

  const openExport = (): void => {
    if (!engine) return;
    const json = engine.poseSetJson();
    setIoText(json);
    setIo('export');
    void navigator.clipboard?.writeText(json).catch(() => undefined);
  };
  const applyImport = (): void => {
    if (!engine) return;
    try {
      engine.loadPoseSet(JSON.parse(ioText) as Partial<Record<RiderPoseName, Partial<RiderPose>>>);
      setIo('none');
    } catch (err) {
      setIoText(`// parse error: ${String(err)}\n\n${ioText}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-mw-bg font-sans text-mw-text">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Bottom-left hint */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-md font-mono text-[11px] leading-relaxed text-mw-muted [text-shadow:0_1px_2px_#000]">
        orbit: drag empty space · click a joint dot to select it · drag its gizmo to move · Save to use it in-game
      </div>

      {/* Panel */}
      <div className="absolute right-0 top-0 z-20 flex h-full w-[340px] flex-col border-l border-mw-edge/60 bg-mw-panel/95 backdrop-blur-md">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.35em] text-mw-accent">
            Rider Pose Editor
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-mw-muted">{vehicleId}</div>
          {!state?.hasRider && (
            <div className="mt-2 rounded border border-mw-hot/50 bg-mw-hot/10 px-2 py-1 text-[11px] text-mw-hot">
              loading rider… (or this bike has no rider)
            </div>
          )}
        </div>

        {/* Pose states */}
        <Section title="Pose state">
          <div className="grid grid-cols-3 gap-1.5">
            {RIDER_POSE_NAMES.map((name) => (
              <Chip key={name} active={state?.pose === name} onClick={() => engine?.setPose(name)}>
                {name}
              </Chip>
            ))}
          </div>
        </Section>

        {/* Target picker */}
        <Section title="Target">
          <div className="space-y-2">
            {groups.map(({ group, items }) => (
              <div key={group}>
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-mw-muted">
                  {group}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {items.map((t) => (
                    <Chip key={t.id} active={state?.target === t.id} onClick={() => engine?.setTarget(t.id)}>
                      {t.label}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Selected-target inspector */}
        {state && selected && (
          <Section title={`${selected.label} — ${selected.kind === 'pole' ? 'bend aim (dir)' : 'position (m)'}`}>
            <Vec3Editor
              value={state.current[selected.field]}
              kind={selected.kind}
              onChange={(axis, v) => engine?.setComponent(selected.field, axis, v)}
            />
            <p className="mt-1.5 text-[11px] text-mw-muted">
              {selected.kind === 'pole'
                ? 'Drag the floating handle in 3D to point the joint where it should bend.'
                : 'Drag the colored gizmo in 3D, or fine-tune the numbers here.'}
            </p>
          </Section>
        )}

        {/* Torso + feet tuning, tucked away */}
        {state && (
          <details className="group rounded border border-mw-edge/50 bg-mw-steel/30">
            <summary className="cursor-pointer select-none px-3 py-2 font-display text-xs font-semibold uppercase tracking-[0.15em] text-mw-text">
              Torso &amp; feet tuning
            </summary>
            <div className="space-y-3 px-3 pb-3">
              {SPINE_BONES.map((b) => (
                <Vec3Editor
                  key={b.field}
                  label={b.label}
                  value={state.current[b.field]}
                  kind="angle"
                  onChange={(axis, v) => engine?.setComponent(b.field, axis, v)}
                />
              ))}
              <Vec3Editor
                label="Foot toe aim"
                value={state.current.footAim}
                kind="pole"
                onChange={(axis, v) => engine?.setComponent('footAim', axis, v)}
              />
            </div>
          </details>
        )}

        {/* Actions */}
        <Section title="Pose set">
          <div className="grid grid-cols-2 gap-1.5">
            <Btn onClick={openExport}>Export JSON</Btn>
            <Btn onClick={() => setIo('import')}>Import JSON</Btn>
            <Btn onClick={() => engine?.copyCurrentToAll()}>Copy → all</Btn>
            <Btn onClick={() => engine?.resetCurrentPose()}>Reset pose</Btn>
          </div>
        </Section>

        {io !== 'none' && (
          <Section title={io === 'export' ? 'Export (copied to clipboard)' : 'Paste a pose set'}>
            <textarea
              data-testid="pose-json"
              value={ioText}
              readOnly={io === 'export'}
              spellCheck={false}
              onChange={(e) => setIoText(e.target.value)}
              className="h-44 w-full resize-y rounded border border-mw-edge/60 bg-mw-bg p-2 font-mono text-[10px] leading-snug text-mw-text"
            />
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {io === 'import' && <Btn onClick={applyImport}>Apply</Btn>}
              <Btn onClick={() => setIo('none')}>Close</Btn>
            </div>
          </Section>
        )}
        </div>

        {/* Save footer — bottom-right, always visible. Persists the pose set to
            this bike (localStorage) so the running game uses it immediately. */}
        <div className="shrink-0 border-t border-mw-edge/60 bg-mw-panel p-3">
          <button
            type="button"
            onClick={saveToGame}
            disabled={!state?.hasRider}
            className="w-full rounded bg-mw-accent px-3 py-2.5 font-display text-sm font-bold uppercase tracking-[0.15em] text-mw-bg transition-colors hover:bg-mw-accent/90 active:scale-[0.99] disabled:opacity-40"
          >
            Save to this bike
          </button>
          <div className="mt-1 text-center font-mono text-[10px] text-mw-muted">
            {savedAt > 0
              ? 'saved ✓ — ride this bike to see it'
              : 'stores locally; used in-game on this device'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section>
      <div className="mb-1.5 font-display text-xs font-semibold uppercase tracking-[0.15em] text-mw-accent">
        {title}
      </div>
      {children}
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'truncate rounded px-2 py-1.5 text-left font-mono text-[11px] capitalize transition-colors active:scale-[0.98] ' +
        (active
          ? 'border border-mw-accent bg-mw-accent/20 text-mw-text'
          : 'border border-mw-edge/60 bg-mw-steel/40 text-mw-muted hover:border-mw-accent/60 hover:text-mw-text')
      }
    >
      {children}
    </button>
  );
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-mw-edge/60 bg-mw-steel/50 px-2 py-1.5 font-display text-[11px] font-semibold uppercase tracking-[0.1em] text-mw-text transition-colors hover:border-mw-accent/60 active:scale-[0.98]"
    >
      {children}
    </button>
  );
}

/** Three axis sliders (x/y/z) for a vec3 field. Ranges depend on the field kind. */
function Vec3Editor({
  value,
  kind,
  label,
  onChange,
}: {
  value: [number, number, number];
  kind: 'pos' | 'pole' | 'angle';
  label?: string;
  onChange: (axis: 0 | 1 | 2, v: number) => void;
}): JSX.Element {
  const [min, max, step] =
    kind === 'pos' ? [-0.9, 0.9, 0.005] : kind === 'angle' ? [-1.5, 1.5, 0.01] : [-1, 1, 0.02];
  const axes: ['x', 'y', 'z'] = ['x', 'y', 'z'];
  return (
    <div>
      {label && <div className="mb-1 text-[11px] text-mw-muted">{label}</div>}
      <div className="space-y-1">
        {axes.map((ax, i) => (
          <div key={ax} className="flex items-center gap-2">
            <span className="w-3 font-mono text-[10px] uppercase text-mw-muted">{ax}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value[i] ?? 0}
              onChange={(e) => onChange(i as 0 | 1 | 2, Number(e.target.value))}
              className="h-1 flex-1 cursor-pointer accent-mw-accent"
            />
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={Number((value[i] ?? 0).toFixed(3))}
              onChange={(e) => onChange(i as 0 | 1 | 2, Number(e.target.value))}
              className="w-14 rounded border border-mw-edge/60 bg-mw-bg px-1 py-0.5 text-right font-mono text-[10px] text-mw-text"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
