---
name: track-editor
description: Comprehensive documentation for the Car Game Track Editor, a React-based visual track design tool for creating element-based racing tracks.
---
# Track Editor Skill

This skill provides comprehensive expertise in developing and maintaining the Car Game Track Editor, a React-based visual track design tool that creates element-based racing tracks.

## Overview

The Track Editor is a sophisticated drag-and-drop interface that allows users to create custom racing tracks using a modern element-based system. It provides real-time visual feedback, validation, and supports both creation and editing of track layouts.

## Reference Documentation

**Primary Reference:** [track.md](../../../track.md) - Complete track data structure specification

The track.md file serves as the canonical reference for:
- Track JSON format validation
- Element type definitions and properties
- Required elements for valid tracks
- Best practices for track design

## Core Architecture

### File Structure

```
client/src/screens/
├── TrackEditor.tsx      # Main editor component
├── TrackEditor.css      # Editor styling
└── components/          # Reusable editor components
```

### Technology Stack

- **Frontend:** React 18 with TypeScript
- **State Management:** React hooks (useState, useEffect, useRef)
- **Canvas:** HTML5 Canvas for track rendering
- **Persistence:** Local file system via browser APIs
- **Validation:** Shared validation utilities from `@shared`

## Key Features

### 1. Element-Based Design System

The editor uses a modern element system where all track components are unified elements with common properties:

```typescript
interface TrackElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  position: { x: number; y: number };
  width: number;
  height: number;
  rotation: number;
  layer: number;
  // Type-specific properties...
}
```

### 2. Visual Element Library

**Road Elements:**
- `road` - Straight road segments
- `road_curve` - Curved road pieces

**Logical Elements (Invisible in Game):**
- `checkpoint` - Race progress tracking
- `spawn` - Vehicle starting positions

**Interactive Elements:**
- `wall` - Collision barriers
- `finish` - Race completion line
- `boost_pad` - Speed enhancement zones
- `oil_slick` - Hazard areas
- `ramp` - Jump elements

### 3. Canvas Management Features

**Selection System:**
- Click to select individual elements
- Canvas selection shows track dimensions
- Multi-element operations support

**Auto-Expand Canvas:**
- Optional automatic canvas expansion
- Maintains elements within bounds
- Configurable via left panel checkbox

**Grid System:**
- Snap-to-grid functionality
- Rotation snapping for precise alignment
- Configurable grid spacing

### 4. Element Manipulation

**Placement:**
- Drag-and-drop from element palette
- Position validation and snapping
- Real-time visual feedback

**Editing:**
- In-place resizing with handles
- Rotation controls with grid snapping
- Property panels for detailed editing

**Organization:**
- Layer-based rendering system
- Z-order management
- Element grouping capabilities

## Supported Capabilities (Current Implementation)

**Core Editing:**
- Create, select, move, resize, and rotate elements on a canvas
- Snap-to-grid positioning and rotation snapping
- Auto-expand canvas as elements approach edges (optional)
- Hide other layers for focused editing (optional)
- Canvas selection for editing track dimensions

**Selection & Workflow:**
- Single selection and multi-select (Ctrl+click)
- Drag-and-drop movement for selected elements
- Undo support (Ctrl+Z + UI button)
- Tool pinning (double-click tool to keep it active)
- Keyboard shortcuts for tools (1-9, 0)

**Element Ordering:**
- Bring to Front / Send to Back for selected elements
- Duplicate and delete selected elements

**Curve System:**
- Curve preset library (45°/90° left/right)
- Custom curve drawing mode
- Curve auto-snapping to nearby road endpoints

**Layers & Properties:**
- Per-element layer assignment (-1, 0, 1, 2)
- Per-element width/height/position/rotation editing
- Checkpoint ordering controls

**Persistence & Loading:**
- Save and load tracks from server storage
- Track list dialog for quick load/copy/delete

**UI/UX:**
- Collapsible left/right panels with resize handles
- Visual tool icons and tool hints
- Properties panel for selected elements

## Implementation Guide

### Adding New Element Types

1. **Define Element Interface** (in shared types):
```typescript
// shared/types/track.ts
export interface NewElementProperties extends TrackElementProperties {
  customProperty: string;
}
```

2. **Update Element Type Union**:
```typescript
type ElementType = 'road' | 'wall' | ... | 'new_element';
```

3. **Add to Element Palette** (TrackEditor.tsx):
```typescript
const elementTypes = [
  // ... existing elements
  {
    type: 'new_element' as const,
    name: 'New Element',
    icon: '🆕',
    defaultWidth: 100,
    defaultHeight: 100,
    color: '#ff5722'
  }
];
```

4. **Implement Rendering** (TrackEditor.tsx):
```typescript
// In drawElement function
case 'new_element':
  ctx.fillStyle = '#ff5722';
  ctx.fillRect(x, y, width, height);
  // Add custom rendering logic
  break;
```

5. **Add Game Renderer Support** (GameRenderer.tsx):
```typescript
// In element rendering switch
case 'new_element': {
  // Implement PIXI.js rendering
  break;
}
```

6. **Update Validation** (shared/utils/validation.ts):
```typescript
// Add validation rules for new element
```

### Canvas Interaction Patterns

**Mouse Event Handling:**
```typescript
const handleCanvasMouseDown = (e: MouseEvent) => {
  const rect = canvasRef.current!.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  // Hit testing logic
  // Selection logic
  // Drag initiation
};
```

**Selection Management:**
```typescript
const [selectedElement, setSelectedElement] = useState<string | null>(null);
const [selectedType, setSelectedType] = useState<'element' | 'canvas'>('element');

// Selection state determines UI behavior
```

**Canvas Auto-Expansion:**
```typescript
const [autoExpand, setAutoExpand] = useState(false);

useEffect(() => {
  if (autoExpand) {
    // Calculate required canvas size
    // Update track dimensions
    // Preserve element positions
  }
}, [elements, autoExpand]);
```

## Track Validation Integration

### Real-Time Validation

The editor implements continuous validation using the shared validation utilities:

```typescript
import { validateTrack } from '@shared';

const validateCurrentTrack = () => {
  const result = validateTrack(currentTrack);
  setValidationErrors(result.errors);
  setIsValid(result.isValid);
};

useEffect(validateCurrentTrack, [elements]);
```

### Validation Feedback

**Error Display:**
- Visual indicators on invalid elements
- Detailed error messages in validation panel
- Save prevention for invalid tracks

**Required Element Checking:**
- Checkpoint sequence validation
- Spawn point requirement checking
- Minimum road surface verification

## Grid and Snapping System

### Grid Configuration
```typescript
const GRID_SIZE = 20; // pixels
const SNAP_THRESHOLD = 10; // pixels
const ROTATION_SNAP = Math.PI / 8; // 22.5 degrees
```

### Snapping Logic
```typescript
const snapToGrid = (value: number): number => {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

const snapRotation = (rotation: number): number => {
  return Math.round(rotation / ROTATION_SNAP) * ROTATION_SNAP;
};
```

## Save/Load System

### Track Serialization
```typescript
const saveTrack = () => {
  const trackData = {
    id: trackId,
    name: trackName,
    width: canvasWidth,
    height: canvasHeight,
    elements: elements,
    // ... other metadata
  };
  
  // Validation before save
  const validation = validateTrack(trackData);
  if (!validation.isValid) {
    showValidationErrors(validation.errors);
    return;
  }
  
  // File save logic
};
```

### Track Loading
```typescript
const loadTrack = async (file: File) => {
  const content = await file.text();
  const trackData = JSON.parse(content);
  
  // Validate loaded data
  const validation = validateTrack(trackData);
  if (!validation.isValid) {
    throw new Error('Invalid track file');
  }
  
  // Update editor state
  setElements(trackData.elements);
  setCanvasWidth(trackData.width);
  setCanvasHeight(trackData.height);
};
```

## Styling and UX Guidelines

### Visual Consistency
- Element colors follow a consistent palette
- Selected elements have distinct highlighting
- Hover states provide clear feedback

### Performance Optimization
- Canvas rendering optimization for large tracks
- Efficient hit testing algorithms
- Debounced validation updates
- Minimal re-renders through proper state management

### Accessibility
- Keyboard shortcuts for common operations
- Screen reader compatible UI elements
- High contrast mode support
- Logical tab order

## Integration Points

### Game Engine Integration
- Element-to-physics conversion in `physicsEngine.ts`
- Real-time track loading during gameplay
- Checkpoint and spawn point processing

### Rendering Integration
- PIXI.js game renderer compatibility
- Canvas minimap rendering
- Element visibility rules (checkpoints/spawns hidden in game)

## Testing Strategy

### Unit Tests
- Element manipulation functions
- Grid snapping logic
- Validation integration
- Canvas interaction calculations

### Integration Tests
- Save/load functionality
- Track validation workflow
- Cross-browser canvas compatibility

### End-to-End Tests
- Complete track creation workflow
- Editor-to-game track loading
- Multi-element operations

## Future Enhancement Areas

### Advanced Features
- Multi-track workspace
- Template system
- Collaborative editing
- Version control integration

### Editor Improvements
- Undo/redo system
- Copy/paste operations
- Element grouping
- Advanced selection tools

### Integration Enhancements
- Cloud storage integration
- Track sharing platform
- Community track library
- Automated track generation

## Troubleshooting Common Issues

### Canvas Rendering Issues
- Check canvas dimensions and scaling
- Verify element positioning calculations
- Debug canvas context state

### Element Positioning Problems
- Validate grid snapping logic
- Check coordinate system consistency
- Verify mouse event coordinate transformation

### Save/Load Problems
- Validate JSON format compliance
- Check file permission issues
- Verify data structure integrity

### Performance Issues
- Profile canvas redraw frequency
- Optimize element iteration loops
- Check for memory leaks in event handlers

## Reference Implementation

The current implementation serves as a reference for:
- Modern React component architecture
- Canvas-based interactive editing
- Real-time validation feedback
- Cross-component state management

All new features should follow established patterns and maintain compatibility with the track data structure defined in `track.md`.