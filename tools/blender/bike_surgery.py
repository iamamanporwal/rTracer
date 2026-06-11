"""Bike GLB surgery — bakes the model edits that used to be done fragilely at
runtime in `bike-visual.ts` straight into the asset, the GTA-engineer-correct way.

Source model: Honda NR750 (Sketchfab, CC-BY-4.0). Its export fuses both wheels
into single meshes (one for all rims, one for all tyres, one for all brakes) and
molds the deployed side-stand into the 38k-vert chassis mesh. This script:

  1. Strips the baked 7x7 cosmetic `floor` plane.
  2. Deletes the deployed side-stand (kickstand) geometry from the chassis.
  3. Merges the fused rims+tyres+brakes, then splits ONCE by the mid-plane into
     clean `wheel_front` / `wheel_rear`, each with its ORIGIN ON THE TRUE HUB so
     it spins without wobble (the old split-by-centroid hack precessed off-axis).
  4. Builds a `steer` pivot at the steering head on the rake axis (~24deg), with
     `wheel_front` + `grips` parented under it, so the runtime turns the front
     wheel + handlebar about the real steering axis with a clamp.

NOTE on the fork: the fork legs / triple-clamp / fairing all share the central
forward volume in this fused mesh and cannot be separated cleanly without artist
remodeling (verified via region / cylinder / flood-fill probes — every selection
either drags the fairing along or leaves holes). So the fork tubes stay fixed;
the front wheel + grips carry the steering. They are ~90% occluded by the
fairing + rider from the chase camera, so this reads correctly in-game.

Blender coords after glTF import: Z = up, X = lateral (+X = bike's left),
Y = longitudinal with the FRONT of the bike at -Y. The exporter converts back to
glTF Y-up on write, so node transforms round-trip to the original frame.

Run:
  blender --background --python tools/blender/bike_surgery.py -- <in.glb> <out.glb>
"""
import bpy, sys, math, bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]

SPLIT_Y = -0.087          # mid-plane between the two wheels (Blender Y, in the gap)
KICKSTAND_FLOOR_Z = 0.12  # chassis verts below this reach the ground = the stand
RAKE_DEG = 24.0           # steering-head rake from vertical (sportbike)
PIVOT_Z = 0.62            # steer-pivot height up the steering axis (Blender Z)


def log(m): print(f"[surgery] {m}", flush=True)
def deselect_all():
    for o in bpy.data.objects: o.select_set(False)
def set_active(o): bpy.context.view_layer.objects.active = o
def wbbox(o):
    mw = o.matrix_world; vs = [mw @ v.co for v in o.data.vertices]
    return (Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))),
            Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs))), len(vs))


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
bpy.ops.object.mode_set(mode='OBJECT')
meshes = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
log(f"imported meshes: {sorted(meshes)}")

# 1) strip floor mesh ──────────────────────────────────────────────────────────
for name, o in list(meshes.items()):
    if 'floor' in name.lower():
        bpy.data.objects.remove(o, do_unlink=True); log(f"removed floor '{name}'")
meshes = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
chassis = next(o for o in meshes.values() if 'CHASSIS' in o.name or 'Bike' in o.name)

# 2) delete kickstand ────────────────────────────────────────────────────────────
set_active(chassis); deselect_all(); chassis.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(chassis.data); bm.verts.ensure_lookup_table()
mw = chassis.matrix_world
for v in bm.verts:
    v.select = (mw @ v.co).z < KICKSTAND_FLOOR_Z      # seed: floor-reaching verts
bmesh.update_edit_mesh(chassis.data)
n_seed = sum(1 for v in bm.verts if v.select)
bpy.ops.mesh.select_linked(delimit=set())             # grow to the whole stand island
bm = bmesh.from_edit_mesh(chassis.data)
linked = [v for v in bm.verts if v.select]
lx = [(mw @ v.co).x for v in linked]; ly = [(mw @ v.co).y for v in linked]; lz = [(mw @ v.co).z for v in linked]
log(f"kickstand seed={n_seed} linked={len(linked)} x[{min(lx):.2f},{max(lx):.2f}] y[{min(ly):.2f},{max(ly):.2f}] z[{min(lz):.2f},{max(lz):.2f}]")
greedy = len(linked) >= 2500 or (max(ly) - min(ly)) >= 0.9 or max(lz) >= 0.45
if greedy:
    log("select_linked too greedy — spatial-box fallback")
    for v in bm.verts:
        c = mw @ v.co; v.select = (c.x > 0.03 and c.z < 0.30 and -0.42 < c.y < 0.34)
    bmesh.update_edit_mesh(chassis.data)
bpy.ops.mesh.delete(type='VERT')
bpy.ops.object.mode_set(mode='OBJECT')
lo, hi, n = wbbox(chassis)
log(f"chassis after stand: n={n} lo=({lo.x:.2f},{lo.y:.2f},{lo.z:.2f}) hi=({hi.x:.2f},{hi.y:.2f},{hi.z:.2f})")

# 3) wheels: merge rims+tyres+brakes, split ONCE by the mid-plane ──────────────────
parts = [o for o in meshes.values() if any(k in o.name.lower() for k in ('rim', 'tyre', 'tire', 'brake'))]
log(f"wheel parts: {[o.name for o in parts]}")
deselect_all()
for o in parts: o.select_set(True)
set_active(parts[0])
bpy.ops.object.join()                                  # one combined wheel-soup object
allwheel = bpy.context.view_layer.objects.active
allwheel.name = 'allwheel'
deselect_all(); allwheel.select_set(True); set_active(allwheel)
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
lo, hi, n = wbbox(allwheel)
log(f"allwheel after join+apply: n={n} y[{lo.y:.2f},{hi.y:.2f}] z[{lo.z:.2f},{hi.z:.2f}]")

# Split via duplicate + delete-half (robust: delete-by-vert respects selection,
# unlike mesh.separate here). wheel_front keeps Y<SPLIT, wheel_rear keeps Y>=SPLIT.
allwheel.name = 'wheel_front'
wheel_front = allwheel
deselect_all(); wheel_front.select_set(True); set_active(wheel_front)
bpy.ops.object.duplicate()
wheel_rear = bpy.context.view_layer.objects.active
wheel_rear.name = 'wheel_rear'

def delete_half(obj, keep_front):
    deselect_all(); obj.select_set(True); set_active(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='VERT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bm = bmesh.from_edit_mesh(obj.data); bm.verts.ensure_lookup_table()
    mw = obj.matrix_world
    ndel = 0
    for v in bm.verts:
        wy = (mw @ v.co).y
        v.select = (wy >= SPLIT_Y) if keep_front else (wy < SPLIT_Y)  # select half to DELETE
        if v.select: ndel += 1
    bm.select_flush(True)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.mesh.delete(type='VERT')
    bpy.ops.object.mode_set(mode='OBJECT')
    return ndel

df = delete_half(wheel_front, keep_front=True)
dr = delete_half(wheel_rear, keep_front=False)
log(f"wheel_front: deleted {df} rear verts, kept {len(wheel_front.data.vertices)}")
log(f"wheel_rear:  deleted {dr} front verts, kept {len(wheel_rear.data.vertices)}")

def set_hub(o):
    lo, hi, _ = wbbox(o)
    hub = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2))  # wheel is symmetric → bbox ctr = hub
    bpy.context.scene.cursor.location = hub
    deselect_all(); o.select_set(True); set_active(o)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    return hub
hub_f = set_hub(wheel_front); hub_r = set_hub(wheel_rear)
log(f"wheel_front hub(Blender)={tuple(round(c,3) for c in hub_f)} verts={len(wheel_front.data.vertices)}")
log(f"wheel_rear  hub(Blender)={tuple(round(c,3) for c in hub_r)} verts={len(wheel_rear.data.vertices)}")

# 4) grips + steer pivot ──────────────────────────────────────────────────────────
grips = next((o for o in bpy.data.objects if o.type == 'MESH' and 'grip' in o.name.lower()), None)
if grips:
    deselect_all(); grips.select_set(True); set_active(grips)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    # drop the now-childless empty wrapper named 'grips' so the rename doesn't collide
    wrap = bpy.data.objects.get('grips')
    if wrap and wrap.type == 'EMPTY' and not wrap.children:
        bpy.data.objects.remove(wrap, do_unlink=True)
    grips.name = 'grips'

# Steering axis: through the front hub, raked back RAKE_DEG from vertical. The
# axis tilts so its TOP leans toward the rear (+Y in Blender).
rake = math.radians(RAKE_DEG)
axis_bl = Vector((0.0, math.sin(rake), math.cos(rake)))          # points up the column
t = (PIVOT_Z - hub_f.z) / axis_bl.z
pivot = Vector((0.0, hub_f.y + t * axis_bl.y, PIVOT_Z))
axis_g = (axis_bl.x, axis_bl.z, -axis_bl.y)                       # glTF/three = (x, z, -y)
pivot_g = (pivot.x, pivot.z, -pivot.y)
log(f"steer rake={RAKE_DEG}deg axis(Blender)=({axis_bl.x:.3f},{axis_bl.y:.3f},{axis_bl.z:.3f}) pivot(Blender)=({pivot.x:.3f},{pivot.y:.3f},{pivot.z:.3f})")
log(f"steer axis(glTF)=({axis_g[0]:.3f},{axis_g[1]:.3f},{axis_g[2]:.3f}) pivot(glTF)=({pivot_g[0]:.3f},{pivot_g[1]:.3f},{pivot_g[2]:.3f})")

steer = bpy.data.objects.new('steer', None)
steer.empty_display_size = 0.12
bpy.context.scene.collection.objects.link(steer)
steer.location = pivot
bpy.context.view_layer.update()
for child in (wheel_front, grips):
    if child is None: continue
    deselect_all(); child.select_set(True); steer.select_set(True); set_active(steer)
    bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)

# 5) cleanup: drop now-childless empty wrapper nodes (rims/tyres/brakes/floor/etc) ──
for o in list(bpy.data.objects):
    if o.type == 'EMPTY' and not o.children and o.name not in ('steer',):
        # keep top scene roots only if they still wrap something; these are leftovers
        if o.name in ('rims', 'tyres', 'brakes', 'floor', 'allwheel') or o.name.endswith('.fbx'):
            pass
    # remove specifically the empty part-wrappers we emptied out
for nm in ('rims', 'tyres', 'brakes', 'floor', 'allwheel'):
    o = bpy.data.objects.get(nm)
    if o and o.type == 'EMPTY' and not o.children:
        bpy.data.objects.remove(o, do_unlink=True); log(f"cleaned empty '{nm}'")

log("hierarchy:")
for o in bpy.data.objects:
    if o.parent is None:
        log(f"  {o.name} ({o.type})")
        for c in o.children: log(f"    └─ {c.name} ({c.type})")

deselect_all()
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', export_yup=True, use_selection=False,
    export_apply=False, export_materials='EXPORT', export_image_format='AUTO', export_extras=False,
)
log(f"exported {OUT}")
