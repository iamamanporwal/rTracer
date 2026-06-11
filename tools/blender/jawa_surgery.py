"""Jawa cafe-racer GLB surgery — integrate the Jawa low-poly bike into rTracer.

Unlike the Honda (one fused 38k chassis), the Jawa ships as ~175 SEPARATE named
parts, so we can group by spatial region with NO geometry cutting (no holes) and
get true fork + handlebar steering. This script:

  1. Re-orients the model to the game convention (front +Z, up +Y, lateral +X)
     and recenters it on the wheelbase mid-plane + ground, so the renderer's
     hardcoded axes (FORWARD=+Z lean, RIGHT=+X wheel spin) work unchanged.
  2. Groups the front/rear wheel parts (tyre+rim+spokes+disc+hub) into
     `wheel_front` / `wheel_rear`, each with ORIGIN ON THE TRUE HUB → no wobble.
  3. Groups the whole front steering assembly (fork legs, triple clamp, fender,
     headlight, handlebar, grips, speedo + the front wheel) under a `steer` pivot
     on the raked steering axis, so the bars + fork + wheel all turn together.
  4. Removes a deployed side-stand if present.

Source orientation (glTF, pre-orient): X = longitudinal (front = -X), Y = up,
Z = lateral. Blender import is Z-up: Blender (x, -gltfZ, gltfY).
Run:
  blender --background --python tools/blender/jawa_surgery.py -- <in.glb> <out.glb> [render_dir]
"""
import bpy, sys, math, bmesh
import numpy as np
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
RENDER_DIR = argv[2] if len(argv) > 2 else None

WHEEL_R = 0.34          # group radius around a hub (wheel parts only; fork is taller)
RAKE_FALLBACK_DEG = 28.0


def log(m): print(f"[jawa] {m}", flush=True)
def deselect():
    for o in bpy.data.objects: o.select_set(False)
def active(o): bpy.context.view_layer.objects.active = o
def wverts(o): return [o.matrix_world @ v.co for v in o.data.vertices]
def centroid(o):
    vs = wverts(o); return sum(vs, Vector()) / len(vs)
def bbox(o):
    vs = wverts(o)
    return (Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))),
            Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs))))


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
bpy.ops.object.mode_set(mode='OBJECT')

# 1) flatten hierarchy (parent_clear keep transform), drop empties ───────────────
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
deselect()
for o in meshes: o.select_set(True)
active(meshes[0])
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
for o in list(bpy.data.objects):
    if o.type == 'EMPTY':
        bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
log(f"flattened to {len(meshes)} mesh objects")

# 2) RE-ORIENT to game convention: rotate +90° about Blender Z so the bike's front
#    (Blender -X) points to Blender -Y (= glTF +Z forward on export). Then recenter.
deselect()
for o in meshes: o.select_set(True)
active(meshes[0])
bpy.context.scene.cursor.location = (0, 0, 0)
bpy.ops.object.origin_set(type='ORIGIN_CURSOR')  # ensure each origin is world (it is, post-clear)
rot = Matrix.Rotation(math.radians(90), 4, 'Z')
for o in meshes:
    o.matrix_world = rot @ o.matrix_world
bpy.context.view_layer.update()
# apply rotation into mesh data so local axes = world axes (clean spin/steer)
deselect()
for o in meshes: o.select_set(True)
active(meshes[0])
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# recenter: wheels currently at Blender Y≈-0.74 (front) & +0.62 (rear); shift so the
# wheelbase midpoint and lateral center sit at origin, ground (min Z) at 0.
allv = [v for o in meshes for v in wverts(o)]
minX = min(v.x for v in allv); maxX = max(v.x for v in allv)
minY = min(v.y for v in allv); maxY = max(v.y for v in allv)
minZ = min(v.z for v in allv)
shift = Vector((-(minX + maxX) / 2, -(minY + maxY) / 2, -minZ))
for o in meshes:
    o.location += shift
bpy.context.view_layer.update()
deselect()
for o in meshes: o.select_set(True); active(o)
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
log(f"oriented + recentered; bbox now X[{minX+shift.x:.2f},{maxX+shift.x:.2f}] Y[{minY+shift.y:.2f},{maxY+shift.y:.2f}]")

# Now Blender frame == Honda frame: X=lateral, Y=longitudinal (front=-Y), Z=up.

# 3) find hubs: the two big tyre rings. Identify wheel-ish circular objects and
#    cluster by longitudinal sign; hub = mean of the largest-radius ring per side.
def yz_dist(c, h): return math.hypot(c.y - h.y, c.z - h.z)
def yz_radius(o):
    lo, hi = bbox(o); return max(hi.y - lo.y, hi.z - lo.z) / 2
def is_round(o):
    lo, hi = bbox(o); s = hi - lo
    # circular in Y-Z (perp to lateral X): Y and Z spans similar & larger than X span
    return s.x < 0.6 * max(s.y, s.z) and abs(s.y - s.z) < 0.3 * max(s.y, s.z) and max(s.y, s.z) > 0.4

round_objs = [o for o in meshes if is_round(o)]
# Hub = centre of the TYRE ring (the largest round object near each side's seed) —
# robust against the rear shock/subframe skewing an averaged centre.
def tyre_hub(seed):
    cands = [o for o in round_objs if yz_dist(centroid(o), seed) < 0.45]
    if not cands:
        return Vector((0, seed.y, 0.31)), 0.31
    tyre = max(cands, key=yz_radius)
    lo, hi = bbox(tyre)
    return Vector((0.0, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)), yz_radius(tyre)
front_hub, front_R = tyre_hub(Vector((0, -0.68, 0.31)))
rear_hub, rear_R = tyre_hub(Vector((0, 0.68, 0.31)))
log(f"front_hub={tuple(round(c,3) for c in front_hub)} R={front_R:.2f}  rear_hub={tuple(round(c,3) for c in rear_hub)} R={rear_R:.2f}")

# 4) classify each object ─────────────────────────────────────────────────────────
# steering head + rake (Blender post-orient): front=-Y. Estimate head above/behind
# the front hub; refine rake from the fork legs (tall steer objects).
HEAD = Vector((0, -0.40, 0.62)); SLOPE = 0.55  # forward boundary moves back as z rises
def max_yz_dist(o, h):
    return max(math.hypot(v.y - h.y, v.z - h.z) for v in wverts(o))
def is_wheel_part(o, hub, R):
    # Only the parts that ACTUALLY rotate — tyre, rim, spokes, brake disc, sprocket,
    # hub — belong to the spinning wheel. Those are rotationally SYMMETRIC about the
    # axle, so their centroid sits ~on the hub AND every vertex stays inside the tyre
    # disc. Anything off-centre (brake caliper, axle stay) or extending past the tyre
    # (chain, fork slider/shock, swingarm, fender) fails one test and is left for the
    # `fork`/static groups — so it no longer fans out when the wheel spins.
    return yz_dist(centroid(o), hub) < 0.28 * R and max_yz_dist(o, hub) < 1.25 * R
def is_front_wheel(o): return is_wheel_part(o, front_hub, front_R)
def is_rear_wheel(o): return is_wheel_part(o, rear_hub, rear_R)
def is_steer(o):
    c = centroid(o)
    boundary_y = HEAD.y + (c.z - HEAD.z) * SLOPE
    return c.y < boundary_y  # forward of the raked steering plane

front_w, rear_w, steer_parts, static_parts = [], [], [], []
for o in meshes:
    if is_front_wheel(o): front_w.append(o)
    elif is_rear_wheel(o): rear_w.append(o)
    elif is_steer(o): steer_parts.append(o)
    else: static_parts.append(o)
log(f"classified: front_wheel={len(front_w)} rear_wheel={len(rear_w)} steer={len(steer_parts)} static={len(static_parts)}")
def dump_wheel(name, objs, hub, R):
    log(f"  {name} parts (cdist/maxdist as frac of R={R:.2f}):")
    for o in sorted(objs, key=lambda o: max_yz_dist(o, hub)):
        log(f"    {o.name:34s} cdist={yz_dist(centroid(o),hub)/R:.2f}R maxdist={max_yz_dist(o,hub)/R:.2f}R")
dump_wheel('front_wheel', front_w, front_hub, front_R)
dump_wheel('rear_wheel', rear_w, rear_hub, rear_R)

# optional classification render (gate via render_dir) ──────────────────────────
if RENDER_DIR:
    cols = {'fw': (0.1, 1, 0.1, 1), 'rw': (0.1, 0.4, 1, 1), 'st': (1, 0.2, 0.2, 1), 'gr': (0.55, 0.55, 0.55, 1)}
    mats = {k: bpy.data.materials.new(k) for k in cols}
    for k, c in cols.items(): mats[k].diffuse_color = c
    def paint(objs, k):
        for o in objs: o.data.materials.clear(); o.data.materials.append(mats[k])
    paint(front_w, 'fw'); paint(rear_w, 'rw'); paint(steer_parts, 'st'); paint(static_parts, 'gr')
    sc = bpy.context.scene; sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.color_type = 'MATERIAL'
    sc.render.resolution_x = 1000; sc.render.resolution_y = 750
    av = [v for o in meshes for v in wverts(o)]
    ctr = Vector((sum(v.x for v in av) / len(av), sum(v.y for v in av) / len(av), 0.45))
    cd = bpy.data.cameras.new('c'); cd.type = 'ORTHO'; cd.ortho_scale = 2.3
    cam = bpy.data.objects.new('c', cd); sc.collection.objects.link(cam); sc.camera = cam
    def shoot(n, loc):
        cam.location = ctr + Vector(loc); cam.rotation_euler = (cam.location - ctr).to_track_quat('Z', 'Y').to_euler()
        sc.render.filepath = f"{RENDER_DIR}/{n}.png"; bpy.ops.render.render(write_still=True)
    shoot('cls_side', (3, 0, 0)); shoot('cls_top', (0, 0, 3)); shoot('cls_q', (2.2, -2.2, 1.1))
    log("rendered classification (cls_side/top/q)")

# 5) group + origins ───────────────────────────────────────────────────────────────
def join_as(objs, name):
    objs = [o for o in objs if o is not None]
    if not objs: return None
    deselect()
    for o in objs: o.select_set(True)
    active(objs[0])
    if len(objs) > 1: bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active; j.name = name
    return j

wheel_front = join_as(front_w, 'wheel_front')
wheel_rear = join_as(rear_w, 'wheel_rear')
# Keep the handlebar GRIPS as their own `grips` mesh (the rider's hand-IK clusters
# its outer ±lateral verts to find the bar ends). The grips are the brown-leather
# parts high up on the bars (the seat is also brown but lower → excluded).
def has_mat(o, name):
    return any(name in (m.name or '') for m in o.data.materials if m)
grip_parts = [o for o in steer_parts if has_mat(o, 'brown_skin') and centroid(o).z > 0.85]
fork_parts = [o for o in steer_parts if o not in grip_parts]
fork = join_as(fork_parts, 'fork')      # fork legs + clamp + fender + headlight + bar tube
grips = join_as(grip_parts, 'grips')    # brown handlebar grips (rider hands target these)
log(f"grip parts={len(grip_parts)} fork parts={len(fork_parts)}")

def set_origin(o, hub):
    # Origin on the tyre-ring axle so the wheel spins true (no wobble).
    if o is None: return
    bpy.context.scene.cursor.location = hub
    deselect(); o.select_set(True); active(o)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
set_origin(wheel_front, front_hub)
set_origin(wheel_rear, rear_hub)
# sanity: the joined wheel's bbox centre should match the tyre hub closely
for w, hub, nm in ((wheel_front, front_hub, 'front'), (wheel_rear, rear_hub, 'rear')):
    if w:
        lo, hi = bbox(w)
        log(f"{nm} wheel bbox centre Y/Z=({(lo.y+hi.y)/2:.3f},{(lo.z+hi.z)/2:.3f}) hub Y/Z=({hub.y:.3f},{hub.z:.3f})")

# Steering axis: through the front hub, raked back by the fork angle. PCA on bulky
# centered geometry is unreliable here (headlight/clamp dominate), so use the
# measured cafe-racer rake; the steered render verifies it visually.
r = math.radians(RAKE_FALLBACK_DEG)
rake_axis = Vector((0.0, math.sin(r), math.cos(r)))  # Blender: front=-Y, so +Y tilt = top leans back
rake_deg = RAKE_FALLBACK_DEG
# pivot: point on the steering axis through the front hub, at clamp height (z=0.62)
t = (0.62 - front_hub.z) / rake_axis.z
pivot = Vector((0.0, front_hub.y + t * rake_axis.y, 0.62))
log(f"rake={rake_deg:.1f}deg axis(Blender)=({rake_axis.x:.3f},{rake_axis.y:.3f},{rake_axis.z:.3f}) pivot(Blender)=({pivot.x:.3f},{pivot.y:.3f},{pivot.z:.3f})")
# glTF/three (export yup): gltf=(bl.x, bl.z, -bl.y)
axis_g = (rake_axis.x, rake_axis.z, -rake_axis.y)
pivot_g = (pivot.x, pivot.z, -pivot.y)
log(f"steer axis(glTF)=({axis_g[0]:.3f},{axis_g[1]:.3f},{axis_g[2]:.3f}) pivot(glTF)=({pivot_g[0]:.3f},{pivot_g[1]:.3f},{pivot_g[2]:.3f})")
# report wheel hubs in glTF too (for the manifest rig)
log(f"front_hub(glTF)=({front_hub.x:.3f},{front_hub.z:.3f},{-front_hub.y:.3f}) rear_hub(glTF)=({rear_hub.x:.3f},{rear_hub.z:.3f},{-rear_hub.y:.3f})")

steer = bpy.data.objects.new('steer', None)
steer.empty_display_size = 0.12
bpy.context.scene.collection.objects.link(steer)
steer.location = pivot
bpy.context.view_layer.update()
for child in (fork, grips, wheel_front):
    if child is None: continue
    deselect(); child.select_set(True); steer.select_set(True); active(steer)
    bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)

# 6) export ─────────────────────────────────────────────────────────────────────────
deselect()
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, use_selection=False,
                          export_apply=False, export_materials='EXPORT', export_image_format='AUTO')
log(f"exported {OUT}")
log("hierarchy:")
for o in bpy.data.objects:
    if o.parent is None and o.type in ('MESH', 'EMPTY'):
        log(f"  {o.name} ({o.type})")
        for c in o.children: log(f"    └─ {c.name}")
