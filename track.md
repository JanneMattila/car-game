# Track Data Structure Documentation

This document defines the complete data structure for track files (`.json`) used by the Car Game. This serves as the canonical reference for track validation and editor development.

## Track File Structure

### Root Track Object

```json
{
  "id": "unique-track-identifier",
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

- **Current Version:** Element-based system
- **Editor:** Creates element-based tracks using modern unified element architecture
- **Game Engine:** Supports element-based track format for optimal performance

## Best Practices

1. **Element Naming:** Use descriptive IDs with prefixes (e.g., `road-main-straight`, `checkpoint-turn-1`)
2. **Layer Organization:** Use layers to control rendering order (roads=0, decorations=1, walls=2)
3. **Checkpoint Spacing:** Place checkpoints at key track sections to ensure proper race progress
4. **Spawn Positioning:** Stagger spawn points to prevent car collisions at race start
5. **Road Connectivity:** Ensure road elements connect properly for continuous racing surface