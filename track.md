# Track Data Structure Documentation

This document defines the complete data structure for track files (`.json`) used by the Car Game. This serves as the canonical reference for track validation and editor development.

## Track File Structure

### Root Track Object

```json
{
  "id": "unique-track-identifier",
  "version": 1,
  "name": "Track Display Name",
  "author": "Track Creator Name",
  "createdAt": 1769357185458,
  "updatedAt": 1769357348431,
  "difficulty": "easy|medium|hard",
  "defaultLapCount": 5,
  "width": 2000,
  "height": 1200,
  "elements": []
}
```

### Track Metadata

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique identifier for the track |
| `version` | number | ✅ | Track format version (current: 1). Used to validate compatibility on import. |
| `name` | string | ✅ | Human-readable track name |
| `author` | string | ✅ | Track creator's name |
| `createdAt` | number | ✅ | Unix timestamp of creation |
| `updatedAt` | number | ✅ | Unix timestamp of last modification |
| `difficulty` | enum | ✅ | One of: "easy", "medium", "hard" |
| `defaultLapCount` | number | ✅ | Default number of laps for races |

### Track Dimensions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `width` | number | ✅ | Track canvas width in pixels |
| `height` | number | ✅ | Track canvas height in pixels |
| `backgroundColor` | string | | Optional six-digit hex terrain color; existing tracks retain their default background |

## Element-Based System

### Elements Array

The `elements` array contains all track components using a modern, unified element system:

```json
{
  "elements": [
    {
      "id": "element-1769357189878",
      "type": "road",
      "x": 120,
      "y": 240,
      "position": {
        "x": 120,
        "y": 240
      },
      "width": 120,
      "height": 360,
      "rotation": 0,
      "layer": 0
    }
  ]
}
```

### Element Base Properties

All elements share these common properties:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique element identifier |
| `type` | string | ✅ | Element type (see types below) |
| `x` | number | ✅ | X coordinate of element |
| `y` | number | ✅ | Y coordinate of element |
| `position` | object | ✅ | Position object with x,y (duplicate for compatibility) |
| `width` | number | ✅ | Element width in pixels |
| `height` | number | ✅ | Element height in pixels |
| `rotation` | number | ✅ | Rotation in radians |
| `layer` | number | ✅ | Rendering layer (0 = bottom) |

## Element Types

### 1. Road Elements

**Type:** `road`

Creates drivable road surfaces for vehicles.

```json
{
  "id": "road-1",
  "type": "road",
  "x": 120,
  "y": 240,
  "width": 120,
  "height": 360,
  "rotation": 0
}
```

**Visual:** Blue/gray rectangular road surface
**Physics:** Provides optimal grip and speed
**Game Logic:** Main racing surface

---

### 2. Road Curve Elements

**Type:** `road_curve`

Creates curved road sections for turns.

```json
{
  "id": "curve-1",
  "type": "road_curve",
  "x": 200,
  "y": 200,
  "width": 100,
  "height": 100,
  "rotation": 1.57
}
```

**Visual:** Curved road segment
**Physics:** Same as regular road
**Game Logic:** Aesthetic curved road piece

#### Editable curves (recommended)

New curves use a cubic Bézier centerline instead of a fixed quarter circle.
All four points are normalized within the element's bounding rectangle.
`rotation` rotates them around the rectangle's center; moving and resizing
the element moves and scales the centerline without changing `roadWidth`.

```json
{
  "id": "editable-curve",
  "type": "road_curve",
  "x": 100,
  "y": 100,
  "position": { "x": 100, "y": 100 },
  "width": 800,
  "height": 600,
  "rotation": 0,
  "layer": 0,
  "properties": {
    "roadWidth": 180,
    "kerbs": true,
    "bezier": {
      "start": { "x": 0.15, "y": 0.85 },
      "control1": { "x": 0.15, "y": 0.3 },
      "control2": { "x": 0.5, "y": 0.15 },
      "end": { "x": 0.85, "y": 0.15 }
    }
  }
}
```

Points must be finite and within `[0, 1]`; `roadWidth` must be at least 20
world units. `kerbs` enables red/white edge strips. Collinear control points
create a straight of any orientation. Legacy curves without `bezier` remain
supported with the original editor geometry. The editor, game renderer, and
minimap use the same sampled centerline. Kerbs are drawn before all asphalt
surfaces to avoid seams at joins.

#### Curve studio workflow

1. Choose **Curve** (shortcut **3**), then a 45-degree, 90-degree, hairpin,
   S-bend, or **Custom / straight** preset. Set road width and kerbs.
2. Drag from the entry point to the exit point. A live asphalt preview shows
   the actual shape. Yellow road-end dots snap the join and align tangents
   on the current layer; disable **Snap curve endpoints** for free placement.
3. Select the curve. Drag yellow start/end handles to relocate its endpoints
   (the attached blue handle moves with it). Drag blue handles to adjust the
   bend. Hold **Alt** to bypass grid and endpoint snapping during handle edits.
4. Use **Curve shape** for exact world-coordinate edits, road width, kerbs,
   **Straighten**, and **Reverse ends**. Legacy arcs offer **Convert to editable
   curve** before reshaping.
5. Scroll over the canvas to zoom around the pointer; **Space + drag** or
   middle-button drag pans. **Fit track (F)** frames the entire circuit.
   Grid spacing, grid snapping, and race-marker visibility are independent.
6. **Ctrl+Z** undoes edits; **Ctrl+Shift+Z** or **Ctrl+Y** redoes them. Keyboard
   shortcuts do not interfere with typing in property fields.

Tracks save through the existing API with a 2 MiB JSON limit. Oversized uploads
return an explicit `413` JSON error. Curve properties survive save, load,
copy, and export/import in format version 1.

### Silverstone Grand Prix

The bundled [Silverstone Grand Prix](data/tracks/silverstone-grand-prix.json)
is an original, arcade-scaled Silverstone-inspired layout, not an official or
survey-accurate replica. It includes Hamilton, Wellington and Hangar straights,
the Village/Loop infield, Copse, linked Maggotts/Becketts bends, and Vale/Club.
The 7,600 × 6,500 finite world has a 240-unit-wide continuous asphalt circuit,
eight staggered grid positions, 26 sequential checkpoints, runoff, rotated
safety barriers, kerbs, corner labels, grandstands, trees and a pit building.
Scenery is decorative (no collision): `tree`, `grandstand`, `building`, and
`label` use the existing position/rotation/scale fields and an optional
`label` string. It appears in both the editor and game.

The reproducible design lives in
[generateSilverstoneTrack.ts](scripts/generateSilverstoneTrack.ts). Run
`npx tsx scripts\generateSilverstoneTrack.ts` from the repository root to
regenerate **only** the bundled Silverstone file. This overwrites edits to that
track; save a copy first if customizing it. Regression tests check closure,
tangent continuity, marker placement, barrier clearance, API round-tripping,
and a continuous physics-driven lap through every checkpoint.

### Formula 1 and NASCAR circuit pack

These original arcade interpretations are not official or survey-accurate replicas.
Monza and Spa race clockwise; Interlagos and the NASCAR ovals race counterclockwise.

| Track | World size | Asphalt width | Character |
|-------|------------|---------------|-----------|
| [Monza Grand Prix](data/tracks/monza-grand-prix.json) | 9,000 x 10,400 | 240 | Long straights, chicanes, Lesmo and Parabolica |
| [Spa-Francorchamps Grand Prix](data/tracks/spa-francorchamps-grand-prix.json) | 11,000 x 9,700 | 240 | La Source, Eau Rouge esses, Kemmel and forest bends |
| [Interlagos Grand Prix](data/tracks/interlagos-grand-prix.json) | 8,200 x 7,900 | 220 | Senna S, backstretch and a technical infield |
| [Daytona Tri-Oval](data/tracks/daytona-tri-oval.json) | 10,500 x 7,100 | 360 | Bowed frontstretch and a straight backstretch |
| [Talladega Superspeedway](data/tracks/talladega-superspeedway.json) | 12,500 x 7,500 | 420 | Large asymmetric tri-oval and extra-wide lanes |
| [Bristol Short Oval](data/tracks/bristol-short-oval.json) | 4,400 x 3,500 | 300 | Compact stadium oval with shorter laps |

Every layout has eight staggered grid slots, one finish line, ordered checkpoints,
continuous editable Bezier roads, rotated inner/outer barriers and decorative scenery.
F1-inspired tracks include red/white kerbs; the NASCAR layouts omit those kerbs.
Elevation and banking are not simulated by the current flat arcade physics.

#### Complete announced 2026 F1 venue collection

The scope follows [Formula 1's announced 24-round 2026 calendar](https://www.formula1.com/en/latest/article/formula-1-reveals-calendar-for-2026-season.YctbMZWqBvrgyddrnauo8),
not subsequent cancellations or a historical inventory of every F1 venue.
Silverstone, Monza, Spa and Interlagos are retained unchanged. Twenty additional
original interpretations complete that venue list:

| Region | New circuits |
|--------|--------------|
| Europe / Azerbaijan | Monaco, Barcelona-Catalunya, Red Bull Ring, Hungaroring, Zandvoort, Madrid Madring, Baku |
| Americas | Miami, Circuit Gilles Villeneuve (Montreal), Circuit of The Americas (Austin), Mexico City, Las Vegas |
| Asia / Australia | Albert Park (Melbourne), Shanghai, Suzuka, Singapore |
| Gulf | Bahrain, Jeddah, Lusail, Yas Marina |

They are scaled, widened arcade courses, not exact surveyed circuit maps.
The descriptions and on-track labels identify signature sectors. Suzuka's
figure-eight crossover uses separated routing because the physics has no grade
separation; Madrid/Zandvoort banking and all elevation remain unsimulated.
New circuits have eight-car grids and finite, continuous barrier-lined routes.

#### Starting from a template

1. Open **Templates** in the editor and compare the circuit and city previews.
   Search by circuit name or corner description and filter by Formula 1, NASCAR
   or Urban. An empty result explicitly reports that no circuits match.
2. Choose a layout, give the copy a name and set asphalt width: 180-280 units for
   F1 courses, 260-440 units for NASCAR speedways, or 220-360 for the Urban city.
3. Choose **Create editable copy**. Roads, walls, checkpoints, finish and the grid
   are rebuilt for the selected width. The new ID protects the saved original.
   The canvas fits the new layout automatically.
4. Edit curves using the Curve studio. Scenery and barriers remain independent
   elements when subsequently reshaping individual curves.
5. **Undo** restores the previous complete canvas; **Redo** restores the copy.
   Save the copy normally to add it to the lobby. Save confirmation is inline;
   errors use the dismissible error banner instead of blocking browser alerts.
   Escape closes the template picker.

Definitions live in [circuitTemplates.ts](shared/tracks/circuitTemplates.ts), with
shared construction in [circuitBuilder.ts](shared/utils/circuitBuilder.ts).
New F1 definitions live in [f1WesternCircuits.ts](shared/tracks/f1WesternCircuits.ts)
and [f1EasternCircuits.ts](shared/tracks/f1EasternCircuits.ts). SVG previews use the
same Bezier definitions as roads, without building full physics barriers.
Run `npm run tracks:generate` to regenerate **all 27 template files**, preserving
Silverstone and player-created tracks. This deliberately overwrites direct edits
to these curated files; use template copies for customization.
Pass one or more template IDs to regenerate only those tracks, for example
`npm run tracks:generate -- pacific-city-circuit`.
If the server is already running, restart it after regeneration to reload its
in-memory catalog. Files are replaced atomically so readers never see partial JSON.
Regression coverage checks closure, tangent continuity, racing direction, complete
grid footprints, barrier clearance at all supported width limits, persistence and
a complete physics-driven lap through every checkpoint of each circuit.

### Pacific City Street Circuit

[Pacific City](data/tracks/pacific-city-circuit.json) is an **original** 13,000 x 10,500
coastal metropolis, not a reproduction of GTA V's copyrighted city map or assets.
Its counterclockwise closed street-racing route includes 24 tangent-continuous curves,
23 ordered checkpoints, eight grid positions, runoff and continuous collision barriers.
The default road width is 280; the Urban template supports 220-360. Downtown blocks,
Sunset Hills, Boardwalk Beach, Marina Canals, Coast Airport and Port Azure use original
procedural vector scenery. Terrain is flat: hills are a visual district, not elevation.
Fit track and the minimum wheel/slider zoom adapt to world and viewport dimensions,
so the entire city remains visible on mobile or with an inspector open.
Background streets, buildings, water and airport scenery are decorative; only the
barriers on the race route collide.

The design is in [pacificCity.ts](shared/tracks/pacificCity.ts). Online research established
broad themes, without tracing a map:

- [GTA V](https://en.wikipedia.org/wiki/Grand_Theft_Auto_V) identifies Los Santos as a fictional Los Angeles-inspired city.
- [Los Angeles](https://en.wikipedia.org/wiki/Los_Angeles) provides coastal, basin and mountain geography.
- [Venice](https://en.wikipedia.org/wiki/Venice,_Los_Angeles) provides beach, pier and canal themes.
- [Port of Los Angeles](https://en.wikipedia.org/wiki/Port_of_Los_Angeles) provides waterfront and container-terminal themes.

Rectangle scenery (`building`, `grandstand`, `area`, `water`, `sand`, `park`, `runway`)
supports optional `width`, `height` (world units before `scale`, at least 20) and a
six-digit hex `color`. Defaults are 200 x 60 for buildings/grandstands and 200 x 200
for surfaces. Trees and labels retain their original styles. Geometry is shared
by Canvas and Pixi renderers in [sceneryGeometry.ts](shared/utils/sceneryGeometry.ts),
including the editor and minimap. Legacy scenery does not need migration.

---

### 3. Wall Elements

**Type:** `wall`

Creates collision barriers that block vehicle movement.

```json
{
  "id": "wall-1",
  "type": "wall",
  "x": 0,
  "y": 0,
  "width": 20,
  "height": 200,
  "rotation": 0
}
```

**Visual:** Red/dark red barrier with border
**Physics:** Solid collision object
**Game Logic:** Blocks vehicle movement, causes crashes

---

### 4. Checkpoint Elements

**Type:** `checkpoint`

Invisible game logic elements that track race progress.

```json
{
  "id": "checkpoint-1",
  "type": "checkpoint",
  "x": 100,
  "y": 420,
  "width": 160,
  "height": 20,
  "rotation": 0,
  "checkpointIndex": 0
}
```

**Additional Properties:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `checkpointIndex` | number | ✅ | Sequential checkpoint number (0-based) |

**Visual:** Invisible in game (shown in editor only)
**Physics:** No collision - detection zone only
**Game Logic:** Must be passed in correct order for lap completion

Checkpoints and finishes are directional gates, not circular proximity zones.
The car center must cross the rotated marker's center plane in its arrow direction
(negative local Y). Swept previous-to-current movement catches fast crossings of
thin gates; height controls the visible marker, not the crossing distance.
Respawns reset the sweep origin, and repeated infinite-track gates use continuous
world coordinates rather than modulo position jumps.

`properties.autoGateWidth` defaults to `true`: the effective gate spans the nearest
barrier faces on its layer, including runoff. Each face must be within 150 units
beyond the authored half-width; distant roads do not enlarge the gate. Without a
nearby pair, the authored width is used and validation warns to cover all drivable
ground manually. This also applies to existing tracks without changing their JSON.
Set it to `false` to retain a manual width. Validation warns if that leaves runoff
uncovered. In the editor, **Race gate** shows the effective width and direction;
**Fit width to barriers** stores the fitted position/width as a manual gate with
undo support. The editor shows the full detection span as a dashed cyan guide;
gameplay and the minimap show only asphalt-clipped finish markings.
Editor gate selection uses the full detection span and a four-pixel hit tolerance,
keeping thin markers selectable when fitting a large city to the viewport.

---

### 5. Finish Line Elements

**Type:** `finish`

Marks the start/finish line for lap completion.

```json
{
  "id": "finish-1",
  "type": "finish",
  "x": 120,
  "y": 420,
  "width": 120,
  "height": 20,
  "rotation": 0
}
```

**Visual:** Black and white checkered pattern
**Physics:** No collision - detection zone only
**Game Logic:** Lap completion after all checkpoints passed

The finish must be crossed **forward after** every ordered checkpoint, including
the order of crossings within a single physics step. Stationary proximity, a
wrong-way crossing, an incomplete checkpoint sequence or a teleport cannot award
a lap. Driving on grass within the finish's barrier corridor still counts.

Finish appearance is independent of the detection gate:

- `properties.finishVisibleWidth`: requested checkerboard width in world units.
  Defaults to the authored element width for legacy tracks; `0` hides all markings.
- `properties.finishVisibleOffset`: lateral offset along the rotated gate's local
  X axis, relative to its authored center. Defaults to `0`; negative moves left.
- Markings are always clipped to asphalt on the same layer and to the detection
  span. Straight/rotated roads, Bézier and legacy curves, bridges/ramps and repeated
  terrain share the same surface geometry as driving resistance. Kerbs are excluded.
- Checkerboards never extend into grass. Grass inside the detection span still
  awards a lap after the ordered checkpoints, even when all markings are hidden.
- The editor's **Visible marking width** / **Visible marking offset** fields have
  undo support. **Fit width to barriers** preserves their world position and width,
  including asymmetric corridors. Toggle race markers to hide the cyan guide.
- `npm run tracks:migrate-finishes` updates legacy saved tracks idempotently.
  It preserves non-finish content and crossing centers/directions. Barrierless
  tracks receive 83 units of invisible runoff on each side, matching circuit-pack
  barrier faces; adjust the detection width manually for other corridor sizes.

---

### 6. Spawn Point Elements

**Type:** `spawn`

Defines where vehicles spawn at race start.

```json
{
  "id": "spawn-1",
  "type": "spawn",
  "x": 120,
  "y": 440,
  "width": 120,
  "height": 60,
  "rotation": 0
}
```

**Visual:** Invisible in game (shown in editor only)
**Physics:** No collision
**Game Logic:** Vehicle starting positions and respawn points

---

### 7. Boost Pad Elements

**Type:** `boost_pad` or `boost`

Provides temporary speed boost to vehicles.

```json
{
  "id": "boost-1",
  "type": "boost_pad",
  "x": 300,
  "y": 300,
  "width": 80,
  "height": 40,
  "rotation": 0
}
```

**Visual:** Orange/yellow boost strip
**Physics:** Detection zone for boost effect
**Game Logic:** Temporarily increases vehicle speed

---

### 8. Oil Slick Elements

**Type:** `oil_slick` or `oil`

Creates slippery hazard areas.

```json
{
  "id": "oil-1",
  "type": "oil_slick",
  "x": 250,
  "y": 350,
  "width": 60,
  "height": 60,
  "rotation": 0
}
```

**Visual:** Dark elliptical oil patch
**Physics:** Reduces vehicle grip significantly
**Game Logic:** Hazard that makes steering difficult

---

### 9. Ramp Elements

**Type:** `ramp`

Creates elevation changes and jump opportunities.

```json
{
  "id": "ramp-1",
  "type": "ramp",
  "x": 400,
  "y": 200,
  "width": 100,
  "height": 20,
  "rotation": 0.5
}
```

**Visual:** Brown/tan ramp surface
**Physics:** Provides upward momentum to vehicles
**Game Logic:** Creates jumping gameplay mechanics

## Track Validation Rules

### Required Elements for Valid Track

1. **Minimum Requirements:**
   - At least 1 road element (for driveable surface)
   - At least 1 checkpoint element
   - At least 1 finish line element
   - At least 1 spawn point element

2. **Checkpoint Rules:**
   - Checkpoints must have sequential indices (0, 1, 2, ...)
   - No gaps in checkpoint sequence
   - Minimum 1 checkpoint required

3. **Spawn Point Rules:**
   - At least 1 spawn point required
   - Spawn points should be on or near road surfaces
   - Should not overlap with walls or hazards

4. **Finish Line Rules:**
   - Exactly 1 finish line recommended
   - Should be positioned after all checkpoints in race flow
   - Should span the width of the track at completion point

5. **Track Boundaries:**
   - Track dimensions must be positive numbers
   - All elements must be within track boundaries (0 ≤ x ≤ width, 0 ≤ y ≤ height)

## File Format

- **Extension:** `.json`
- **Encoding:** UTF-8
- **Format:** Standard JSON with proper indentation
- **Location:** `data/tracks/` directory
- **Naming:** Use kebab-case for file names (e.g., `my-race-track.json`)

## Version Compatibility

- **Current Version:** 1 (element-based system)
- **Version Field:** Every track file must include a `version` field. The system checks this on import and rejects tracks with a version higher than the currently supported version.
- **Editor:** Creates element-based tracks using modern unified element architecture
- **Game Engine:** Supports element-based track format for optimal performance

## Best Practices

1. **Element Naming:** Use descriptive IDs with prefixes (e.g., `road-main-straight`, `checkpoint-turn-1`)
2. **Layer Organization:** Use layers to control rendering order (roads=0, decorations=1, walls=2)
3. **Checkpoint Spacing:** Place checkpoints at key track sections to ensure proper race progress
4. **Spawn Positioning:** Stagger spawn points to prevent car collisions at race start
5. **Road Connectivity:** Ensure road elements connect properly for continuous racing surface