import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useNetworkStore } from '../store/networkStore';
import { 
  Track, 
  TrackElement, 
  TrackElementType,
  DEFAULT_TRACK,
  CURRENT_TRACK_VERSION,
  RoadBezier,
  CurvePreset,
  CURVE_PRESETS,
  createBezierRoad,
  getRoadBezier,
  presetBezier,
  nearestRoadEndpoint,
  alignBezierEndpoint,
  hitTestRoadCurve,
  getRoadEndpoints,
  roadStrokeWidth,
  validateTrack,
  fitRaceGate,
  effectiveRaceGate,
  preserveFinishMarkings,
} from '@shared';
import './TrackEditor.css';
import { drawRoadCurve, drawScenery, drawFinishMarkings } from '../utils/trackDrawing';
import CircuitTemplateDialog from './components/CircuitTemplateDialog';
import { fitEditorViewport } from '../utils/editorViewport';

interface Point {
  x: number;
  y: number;
}

const ELEMENT_TYPES: { type: TrackElementType; label: string; icon: string }[] = [
  { type: 'select', label: 'Select', icon: '👆' },
  { type: 'road', label: 'Road', icon: '🛣️' },
  { type: 'road_curve', label: 'Curve', icon: '➰' },
  { type: 'wall', label: 'Wall', icon: '🧱' },
  { type: 'checkpoint', label: 'Checkpoint', icon: '🚩' },
  { type: 'finish', label: 'Finish Line', icon: '🏁' },
  { type: 'boost', label: 'Boost Pad', icon: '⚡' },
  { type: 'oil', label: 'Oil Slick', icon: '🛢️' },
  { type: 'spawn', label: 'Spawn Point', icon: '🚗' },
  { type: 'bridge', label: 'Bridge', icon: '🌉' },
  { type: 'ramp_up', label: 'Ramp Up', icon: '⬆️' },
  { type: 'ramp_down', label: 'Ramp Down', icon: '⬇️' },
  { type: 'car', label: 'Car (Reference)', icon: '🚙' },
];

const degToRad = (deg: number) => (deg * Math.PI) / 180;
const radToDeg = (rad: number) => (rad * 180) / Math.PI;

function TrackEditor() {
  const navigate = useNavigate();
  const { trackId } = useParams<{ trackId: string }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const spaceHeld = useRef(false);
  const dragHasHistory = useRef(false);
  const { trackList, requestTrackList, connected } = useNetworkStore();
  
  const [track, setTrack] = useState<Track>({ ...DEFAULT_TRACK });
  const [selectedTool, setSelectedTool] = useState<TrackElementType>('select');
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [selectedElements, setSelectedElements] = useState<string[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawPoints, setDrawPoints] = useState<Point[]>([]);
  const [gridSize, setGridSize] = useState(20);
  const [showGrid, setShowGrid] = useState(true);
  const [showRaceMarkers, setShowRaceMarkers] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const minimumZoom = fitEditorViewport(track.width, track.height, viewport).minimumZoom;
  const [panDrag, setPanDrag] = useState<{ x: number; y: number; pan: Point } | null>(null);
  const [curvePreset, setCurvePreset] = useState<CurvePreset>('right90');
  const [roadWidth, setRoadWidth] = useState(160);
  const [curveKerbs, setCurveKerbs] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [endpointSnap, setEndpointSnap] = useState(true);
  const [curveDrag, setCurveDrag] = useState<{
    id: string; handle: keyof RoadBezier; original: Track; curve: RoadBezier;
  } | null>(null);
  const [currentLayer, setCurrentLayer] = useState(0); // Layer for new elements
  const [hideOtherLayers, setHideOtherLayers] = useState(false);
  const [autoExpandCanvas, setAutoExpandCanvas] = useState(false);
  const [dragState, setDragState] = useState<{ 
    elementIds: string[]; 
    mode: 'move' | 'resize'; 
    elementStartPositions: { id: string; x: number; y: number }[];
    startPoint: { x: number; y: number };
    offsetX: number; 
    offsetY: number; 
    corner?: string; 
    originalSize?: { width: number; height: number };
    isDragging?: boolean;
  } | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(window.innerWidth < 1000);
  const [rightCollapsed, setRightCollapsed] = useState(window.innerWidth < 1300);
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(320);
  const [resizingPanel, setResizingPanel] = useState<null | { panel: 'left' | 'right'; startX: number; startWidth: number }>(null);
  const [showSelectedSection, setShowSelectedSection] = useState(true);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [undoHistory, setUndoHistory] = useState<Track[]>([]);
  const [redoHistory, setRedoHistory] = useState<Track[]>([]);
  const [pinnedTool, setPinnedTool] = useState<TrackElementType | null>(null);

  const toolHints: Record<TrackElementType, string> = {
    select: 'Select, move, and resize track elements',
    road: 'Straight road segment',
    road_curve: 'Drag start to end; reshape with the four curve handles',
    wall: 'Barrier wall to block cars',
    checkpoint: 'Checkpoint that orders lap progress',
    finish: 'Finish line for race completion',
    boost: 'Boost pad that speeds cars up briefly',
    boost_pad: 'Boost pad that speeds cars up briefly',
    oil: 'Oil slick that reduces grip',
    oil_slick: 'Oil slick that reduces grip',
    spawn: 'Player spawn position',
    bridge: 'Bridge segment on elevated layer',
    ramp: 'Angled ramp segment',
    ramp_up: 'Ramp that sends cars upward',
    ramp_down: 'Ramp that brings cars back down',
    barrier: 'Traffic barrier to block cars',
    tire_stack: 'Stack of tires as obstacle',
    pit_stop: 'Pit stop area for repairs',
    car: 'Visual reference of actual car size (not saved)',
  };

  const updateElement = (elementId: string, updater: (el: TrackElement) => TrackElement) => {
    setTrack(prev => ({
      ...prev,
      elements: prev.elements.map(el => {
        if (el.id !== elementId) return el;
        const updated = updater(el);
        return { ...updated, position: { x: updated.x, y: updated.y } };
      }),
    }));
  };

  const updateMultipleElements = (elementIds: string[], updater: (el: TrackElement) => TrackElement) => {
    setTrack(prev => ({
      ...prev,
      elements: prev.elements.map(el => {
        if (!elementIds.includes(el.id)) return el;
        const updated = updater(el);
        return { ...updated, position: { x: updated.x, y: updated.y } };
      }),
    }));
  };

  const updateSelectedElements = (updater: (el: TrackElement) => TrackElement) => {
    const elementsToUpdate = selectedElements.length > 0 ? selectedElements : (selectedElement ? [selectedElement] : []);
    if (elementsToUpdate.length > 0) {
      updateMultipleElements(elementsToUpdate, updater);
    }
  };

  const reorderSelectedElements = (position: 'front' | 'back') => {
    const elementIds = selectedElements.length > 0 ? selectedElements : (selectedElement ? [selectedElement] : []);
    if (elementIds.length === 0) return;

    setTrack(prev => {
      const selectedSet = new Set(elementIds);
      const selected = prev.elements.filter(el => selectedSet.has(el.id));
      const others = prev.elements.filter(el => !selectedSet.has(el.id));
      const elements = position === 'front' ? [...others, ...selected] : [...selected, ...others];
      return { ...prev, elements };
    });
  };

  const renumberCheckpoints = (elements: TrackElement[]): TrackElement[] => {
    const checkpoints = elements.filter(e => e.type === 'checkpoint');
    checkpoints.sort((a, b) => (a.checkpointIndex ?? 0) - (b.checkpointIndex ?? 0));
    let idx = 0;
    return elements.map(el => {
      if (el.type !== 'checkpoint') return el;
      const updated = { ...el, checkpointIndex: idx };
      idx += 1;
      return updated;
    });
  };

  const expandCanvasIfNeeded = (element: TrackElement) => {
    if (!autoExpandCanvas) return; // Only expand if auto-expand is enabled
    
    const BORDER_THRESHOLD = 100; // Expand when element is within 100px of border
    const EXPANSION_SIZE = 400; // How much to expand by
    
    const elementRight = element.x + element.width;
    const elementBottom = element.y + element.height;
    
    let newWidth = track.width;
    let newHeight = track.height;
    
    // Check if element is near right border
    if (elementRight > track.width - BORDER_THRESHOLD) {
      newWidth = elementRight + EXPANSION_SIZE;
    }
    
    // Check if element is near bottom border
    if (elementBottom > track.height - BORDER_THRESHOLD) {
      newHeight = elementBottom + EXPANSION_SIZE;
    }
    
    // Update track dimensions if needed
    if (newWidth !== track.width || newHeight !== track.height) {
      setTrack(prev => ({
        ...prev,
        width: newWidth,
        height: newHeight
      }));
    }
  };

  const hitTestElement = (point: Point, element: TrackElement): boolean => {
    if (element.type === 'road_curve') return hitTestRoadCurve(point, element, 4 / zoom);
    const isRaceGate = element.type === 'finish' || element.type === 'checkpoint';
    const shape = isRaceGate ? effectiveRaceGate(track, element) : element;
    const tolerance = isRaceGate ? 4 / zoom : 0;
    const rotation = shape.rotation || 0;
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    
    // Use rectangular hit test for all elements including curves
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const localX = dx * cos - dy * sin + shape.width / 2;
    const localY = dx * sin + dy * cos + shape.height / 2;
    return localX >= -tolerance && localX <= shape.width + tolerance &&
      localY >= -tolerance && localY <= shape.height + tolerance;
  };

  const hitResizeCorner = (point: Point, element: TrackElement, tolerance = 12 / zoom): string | false => {
    // Cars and spawn points cannot be resized
    if (element.type === 'car' || element.type === 'spawn' || element.properties?.bezier) return false;
    
    const rotation = element.rotation || 0;
    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    
    // Use rectangular corner detection for all elements including curves
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const localX = dx * cos - dy * sin + element.width / 2;
    const localY = dx * sin + dy * cos + element.height / 2;
    if (localX < -tolerance || localY < -tolerance ||
      localX > element.width + tolerance || localY > element.height + tolerance) return false;
    
    // Check each corner
    if (localX <= tolerance && localY <= tolerance) return 'top-left';
    if (localX >= element.width - tolerance && localY <= tolerance) return 'top-right';
    if (localX <= tolerance && localY >= element.height - tolerance) return 'bottom-left';
    if (localX >= element.width - tolerance && localY >= element.height - tolerance) return 'bottom-right';
    
    return false;
  };

  // Request track list when connected (or when connected changes to true)
  useEffect(() => {
    if (connected) {
      requestTrackList();
    }
  }, [connected, requestTrackList]);

  // Add track state to undo history
  const addToHistory = useCallback(() => {
    setRedoHistory([]);
    setUndoHistory(prev => {
      const newHistory = [...prev, track];
      return newHistory.slice(-50); // Keep last 50 states
    });
  }, [track]);

  // Handle undo
  const handleUndo = useCallback(() => {
    if (undoHistory.length === 0) return;
    
    const previousState = undoHistory[undoHistory.length - 1];
    if (!previousState) return;
    setRedoHistory(prev => [...prev, track]);
    setTrack(previousState);
    setUndoHistory(prev => prev.slice(0, -1));
    setSelectedElement(null);
    setSelectedElements([]);
  }, [undoHistory, track]);

  const handleRedo = useCallback(() => {
    const next = redoHistory[redoHistory.length - 1];
    if (!next) return;
    setUndoHistory(prev => [...prev, track].slice(-50));
    setTrack(next);
    setRedoHistory(prev => prev.slice(0, -1));
    setSelectedElement(null);
    setSelectedElements([]);
  }, [redoHistory, track]);

  const fitTrack = useCallback(() => {
    const fitted = fitEditorViewport(track.width, track.height, viewport);
    setZoom(fitted.zoom);
    setPan(fitted.pan);
  }, [track.width, track.height, viewport]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport({
        width: Math.max(1, Math.floor(entry.contentRect.width)),
        height: Math.max(1, Math.floor(entry.contentRect.height)),
      });
      element.scrollLeft = 0;
      element.scrollTop = 0;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1000) setLeftCollapsed(true);
      if (window.innerWidth < 1300) setRightCollapsed(true);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    fitTrack();
  }, [track.id, viewport.width, viewport.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const nextZoom = Math.max(minimumZoom, Math.min(3, zoom * Math.exp(-e.deltaY * 0.001)));
      setPan({ x: x - (x - pan.x) * nextZoom / zoom, y: y - (y - pan.y) * nextZoom / zoom });
      setZoom(nextZoom);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoom, pan, minimumZoom]);

  // Handle tool selection with automatic pin removal
  const handleToolSelect = useCallback((toolType: TrackElementType) => {
    // If there's a pinned tool and we're selecting a different tool, remove the pin
    if (pinnedTool && pinnedTool !== toolType) {
      setPinnedTool(null);
    }
    setSelectedTool(toolType);
    setIsDrawing(false);
    setDrawPoints([]);
  }, [pinnedTool]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        spaceHeld.current = true;
        return;
      }
      // Ctrl+Z for undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      
      // Number keys for tool selection (1-9, then 0 for tool 10)
      if (e.key >= '1' && e.key <= '9') {
        const toolIndex = parseInt(e.key) - 1;
        const tool = ELEMENT_TYPES[toolIndex];
        if (tool) {
          handleToolSelect(tool.type);
        }
        return;
      }
      if (e.key === '0') {
        const toolIndex = 9; // 0 key = 10th tool (index 9)
        const tool = ELEMENT_TYPES[toolIndex];
        if (tool) {
          handleToolSelect(tool.type);
        }
        return;
      }
      
      if (e.key === 'Delete' && selectedElement) {
        handleDeleteElement();
      } else if (e.key === 'Escape' && curveDrag) {
        setTrack(curveDrag.original);
        setCurveDrag(null);
      } else if (e.key === 'Escape' && isDrawing) {
        setIsDrawing(false);
        setDrawPoints([]);
      } else if (e.key.toLowerCase() === 'f') {
        fitTrack();
      } else if (e.key === 'Escape' && dragState && dragState.mode === 'resize' && dragState.originalSize) {
        // Cancel resize and restore original size
        updateElement(dragState.elementIds[0]!, cur => ({
          ...cur,
          width: dragState.originalSize!.width,
          height: dragState.originalSize!.height
        }));
        setDragState(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const releaseSpace = () => { spaceHeld.current = false; };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') releaseSpace(); };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseSpace);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseSpace);
    };
  }, [selectedElement, dragState, curveDrag, isDrawing, handleUndo, handleRedo, handleToolSelect, fitTrack]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    ctx.fillStyle = track.backgroundColor ?? '#222238';
    ctx.fillRect(0, 0, track.width, track.height);

    // Draw grid
    if (showGrid) {
      ctx.strokeStyle = '#2a2a4e';
      ctx.lineWidth = 0.5;
      const visibleGrid = gridSize * Math.max(1, Math.ceil(8 / (gridSize * zoom)));
      const minX = Math.max(0, Math.floor(-pan.x / zoom / visibleGrid) * visibleGrid);
      const minY = Math.max(0, Math.floor(-pan.y / zoom / visibleGrid) * visibleGrid);
      const maxX = Math.min(track.width, (canvas.width - pan.x) / zoom);
      const maxY = Math.min(track.height, (canvas.height - pan.y) / zoom);
      for (let x = minX; x < maxX; x += visibleGrid) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, track.height);
        ctx.stroke();
      }
      for (let y = minY; y < maxY; y += visibleGrid) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(track.width, y);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#8994a5';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, track.width, track.height);
    (track.scenery ?? []).forEach(item => drawScenery(ctx, item));

    const drawRect = (
      element: TrackElement,
      fillStyle: string,
      strokeStyle?: { color: string; width?: number }
    ) => {
      const rotation = element.rotation || 0;
      const cx = element.x + element.width / 2;
      const cy = element.y + element.height / 2;
      ctx.save();
      ctx.translate(cx, cy);
      if (rotation) ctx.rotate(rotation);
      ctx.translate(-element.width / 2, -element.height / 2);
      ctx.fillStyle = fillStyle;
      ctx.fillRect(0, 0, element.width, element.height);
      if (strokeStyle) {
        ctx.strokeStyle = strokeStyle.color;
        ctx.lineWidth = strokeStyle.width ?? 2;
        ctx.strokeRect(0, 0, element.width, element.height);
      }
      ctx.restore();
    };

    const drawArrow = (element: TrackElement, color: string) => {
      const cx = element.x + element.width / 2;
      const cy = element.y + element.height / 2;
      const rotation = element.rotation || 0;
      ctx.save();
      ctx.translate(cx, cy);
      if (rotation) ctx.rotate(rotation);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -element.height / 3);
      ctx.lineTo(element.width / 4, element.height / 4);
      ctx.lineTo(-element.width / 4, element.height / 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    // Draw elements (respect layer filter)
    const elementsToDraw = track.elements.filter(el =>
      (!hideOtherLayers || (el.layer ?? 0) === currentLayer) &&
      (showRaceMarkers || (el.type !== 'checkpoint' && el.type !== 'spawn')));
    elementsToDraw.filter(el => el.type === 'road_curve').forEach(element =>
      drawRoadCurve(ctx, element, false, 'base'));

    elementsToDraw.forEach((original) => {
      const element = effectiveRaceGate(track, original);
      const isSelected = element.id === selectedElement;
      const isMultiSelected = selectedElements.includes(element.id);
      const rotation = element.rotation || 0;
      const cx = element.x + element.width / 2;
      const cy = element.y + element.height / 2;

      switch (element.type) {
        case 'road':
          drawRect(element, isSelected ? '#4a4a6e' : '#3a3a5e');
          break;
        case 'road_curve':
          drawRoadCurve(ctx, element, isSelected, 'surface');
          break;
        case 'barrier':
        case 'wall':
          drawRect(element, isSelected ? '#8b0000' : '#4a0000');
          break;
        case 'checkpoint': {
          drawRect(element, isSelected ? 'rgba(255, 255, 0, 0.5)' : 'rgba(255, 255, 0, 0.3)', {
            color: '#ffff00',
            width: 2,
          });
          // Direction arrow (shows respawn facing direction)
          drawArrow(element, 'rgba(255, 255, 0, 0.7)');
          // Checkpoint order label
          ctx.save();
          ctx.translate(cx, cy);
          if (rotation) ctx.rotate(rotation);
          ctx.fillStyle = '#ffff00';
          ctx.font = '16px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(element.checkpointIndex ?? 0), 0, 0);
          ctx.restore();
          if (isSelected) {
            ctx.save();
            ctx.translate(cx, cy);
            if (rotation) ctx.rotate(rotation);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(element.width / 2 - 10, element.height / 2 - 10, 12, 12); // resize handle hint
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.strokeRect(element.width / 2 - 10, element.height / 2 - 10, 12, 12);
            ctx.restore();
          }
          break;
        }
        case 'finish': {
          drawFinishMarkings(ctx, track, original);
          if (showRaceMarkers) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rotation);
            ctx.strokeStyle = '#00d9ff';
            ctx.lineWidth = 1.5 / zoom;
            ctx.setLineDash([5 / zoom, 4 / zoom]);
            ctx.strokeRect(-element.width / 2, -element.height / 2, element.width, element.height);
            ctx.restore();
            drawArrow(element, '#00d9ff');
          }
          break;
        }
        case 'boost':
          drawRect(element, isSelected ? 'rgba(0, 255, 255, 0.6)' : 'rgba(0, 255, 255, 0.4)');
          drawArrow(element, 'white');
          break;
        case 'oil':
          ctx.save();
          ctx.translate(cx, cy);
          if (rotation) ctx.rotate(rotation);
          ctx.fillStyle = isSelected ? 'rgba(50, 50, 50, 0.8)' : 'rgba(30, 30, 30, 0.7)';
          ctx.beginPath();
          ctx.ellipse(0, 0, element.width / 2, element.height / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        case 'spawn':
          drawRect(element, isSelected ? 'rgba(0, 255, 0, 0.6)' : 'rgba(0, 255, 0, 0.4)', {
            color: '#00ff00',
            width: 2,
          });
          drawArrow(element, '#00ff00');
          break;
        case 'bridge':
          drawRect(element, isSelected ? 'rgba(139, 90, 43, 0.8)' : 'rgba(139, 69, 19, 0.7)', {
            color: '#8b4513',
            width: 3,
          });
          ctx.save();
          ctx.translate(cx, cy);
          if (rotation) ctx.rotate(rotation);
          ctx.fillStyle = 'white';
          ctx.font = '12px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`L${element.layer ?? 1}`, 0, 0);
          ctx.restore();
          break;
        case 'ramp_up':
          drawRect(element, isSelected ? 'rgba(100, 200, 100, 0.7)' : 'rgba(80, 180, 80, 0.6)');
          drawArrow(element, 'white');
          if (isSelected) {
            ctx.save();
            ctx.translate(cx, cy);
            if (rotation) ctx.rotate(rotation);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(element.width / 2 - 10, element.height / 2 - 10, 12, 12);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.strokeRect(element.width / 2 - 10, element.height / 2 - 10, 12, 12);
            ctx.restore();
          }
          break;
        case 'ramp_down':
          drawRect(element, isSelected ? 'rgba(200, 100, 100, 0.7)' : 'rgba(180, 80, 80, 0.6)');
          drawArrow(element, 'white');
          if (isSelected) {
            ctx.save();
            ctx.translate(cx, cy);
            if (rotation) ctx.rotate(rotation);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(element.width / 2 - 10, element.height / 2 - 10, 12, 12);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.strokeRect(element.width / 2 - 10, element.height / 2 - 10, 12, 12);
            ctx.restore();
          }
          break;
        case 'car':
          drawRect(element, isSelected ? 'rgba(255, 165, 0, 0.8)' : 'rgba(255, 165, 0, 0.6)', {
            color: '#ff8c00',
            width: 2,
          });
          // Draw car icon
          ctx.save();
          ctx.translate(cx, cy);
          if (rotation) ctx.rotate(rotation);
          ctx.fillStyle = 'white';
          ctx.font = '20px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('🚙', 0, 0);
          ctx.restore();
          break;
      }

      if (isSelected) {
        ctx.save();
        ctx.translate(cx, cy);
        if (rotation) ctx.rotate(rotation);
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        
        if (element.type === 'road_curve') {
          // Only draw bounding box for curves
          ctx.strokeRect(-element.width / 2, -element.height / 2, element.width, element.height);
        } else {
          // Draw rectangular selection for other elements
          ctx.strokeRect(-element.width / 2, -element.height / 2, element.width, element.height);
        }
        
        // Draw resize handles for elements that can be resized (not cars or spawns)
        if (element.type !== 'car' && element.type !== 'spawn' && !element.properties?.bezier) {
          ctx.setLineDash([]);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#00ff00';
          ctx.lineWidth = 1;
          
          const handleSize = 8 / zoom;
          const halfWidth = element.width / 2;
          const halfHeight = element.height / 2;
          
          // Draw corner resize handles
          const corners: [number, number][] = [
            [-halfWidth, -halfHeight], // top-left
            [halfWidth, -halfHeight],  // top-right
            [-halfWidth, halfHeight],  // bottom-left
            [halfWidth, halfHeight]    // bottom-right
          ];
          
          corners.forEach(([x, y]) => {
            ctx.fillRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize);
            ctx.strokeRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize);
          });
        }
        
        ctx.restore();
      }
      
      // Draw multi-select indicator
      if (isMultiSelected && !isSelected) {
        ctx.save();
        ctx.translate(cx, cy);
        if (rotation) ctx.rotate(rotation);
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(-element.width / 2, -element.height / 2, element.width, element.height);
        ctx.restore();
      }
      
      // Draw layer indicator for elevated elements (layer > 0)
      if ((element.layer ?? 0) !== 0 && element.type !== 'bridge') {
        ctx.save();
        ctx.translate(cx, cy);
        if (rotation) ctx.rotate(rotation);
        ctx.strokeStyle = element.layer && element.layer > 0 ? '#00ff00' : '#ff6600';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(-element.width / 2, -element.height / 2, element.width, element.height);
        ctx.restore();
      }
    });

    const selectedCurveElement = track.elements.find(el => el.id === selectedElement);
    const selectedCurve = selectedCurveElement && getRoadBezier(selectedCurveElement);
    if (selectedCurve) {
      ctx.save();
      ctx.strokeStyle = '#6de8ff';
      ctx.lineWidth = 1.5 / zoom;
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.beginPath();
      ctx.moveTo(selectedCurve.start.x, selectedCurve.start.y);
      ctx.lineTo(selectedCurve.control1.x, selectedCurve.control1.y);
      ctx.moveTo(selectedCurve.end.x, selectedCurve.end.y);
      ctx.lineTo(selectedCurve.control2.x, selectedCurve.control2.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [key, p] of Object.entries(selectedCurve)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = key === 'start' || key === 'end' ? '#f9d65c' : '#6de8ff';
        ctx.fill();
        ctx.strokeStyle = '#182738';
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `${12 / zoom}px sans-serif`;
        ctx.fillText(key === 'control1' ? 'Handle 1' : key === 'control2' ? 'Handle 2' : key, p.x + 10 / zoom, p.y - 10 / zoom);
      }
      ctx.restore();
    }
    if (selectedTool === 'road_curve' && endpointSnap) {
      ctx.save();
      ctx.fillStyle = '#f9d65c';
      for (const el of elementsToDraw) {
        for (const endpoint of getRoadEndpoints(el)) {
          ctx.beginPath();
          ctx.arc(endpoint.point.x, endpoint.point.y, 3 / zoom, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Draw current drawing
    if (isDrawing && drawPoints.length > 0) {
      if (selectedTool === 'road_curve' && drawPoints.length >= 2) {
        const preview = makeCurve(drawPoints[0]!, drawPoints[drawPoints.length - 1]!);
        ctx.save();
        ctx.globalAlpha = 0.8;
        drawRoadCurve(ctx, preview, true);
        ctx.restore();
      } else {
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      
      const start = drawPoints[0];
      const end = drawPoints[drawPoints.length - 1];
      if (start && end) {
        ctx.strokeRect(
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y)
        );
      }
      ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }, [track, selectedElement, selectedElements, showGrid, showRaceMarkers, gridSize, zoom, pan, isDrawing, drawPoints, hideOtherLayers, currentLayer, viewport, selectedTool, curvePreset, roadWidth, curveKerbs, endpointSnap]);

  const snapToGrid = (value: number): number => {
    return snapEnabled ? Math.round(value / gridSize) * gridSize : value;
  };

  // Panel resizing handlers
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!resizingPanel) return;
      const delta = e.clientX - resizingPanel.startX;
      if (resizingPanel.panel === 'left') {
        setLeftWidth(Math.max(200, Math.min(420, resizingPanel.startWidth + delta)));
      } else {
        setRightWidth(Math.max(200, Math.min(420, resizingPanel.startWidth - delta)));
      }
    };
    const handleUp = () => setResizingPanel(null);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [resizingPanel]);

  const getCanvasPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    };
  };

  const snapCurveEndpoint = (point: Point, excludeId?: string) => endpointSnap
    ? nearestRoadEndpoint(point, track.elements.filter(el => (el.layer ?? 0) === currentLayer), Math.min(80, 18 / zoom), excludeId)
    : null;

  const makeCurve = (start: Point, end: Point): TrackElement => {
    let curve = presetBezier(start, end, curvePreset);
    const startSnap = snapCurveEndpoint(start);
    const endSnap = snapCurveEndpoint(end);
    if (startSnap) curve = alignBezierEndpoint(curve, startSnap, true);
    if (endSnap) curve = alignBezierEndpoint(curve, endSnap, false);
    return createBezierRoad(`element-${Date.now()}`, curve, roadWidth, currentLayer, curveKerbs);
  };

  const reshapeCurve = (element: TrackElement, curve: RoadBezier, width = roadStrokeWidth(element)) => {
    const updated = createBezierRoad(element.id, curve, width, element.layer ?? 0, element.properties?.kerbs ?? false);
    updateElement(element.id, () => ({ ...element, ...updated, properties: { ...element.properties, ...updated.properties } }));
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      e.preventDefault();
      setPanDrag({ x: e.clientX, y: e.clientY, pan });
      return;
    }
    if (e.button !== 0) return;
    const point = getCanvasPoint(e);
    const isCtrlClick = e.ctrlKey;
    
    dragHasHistory.current = false;

    if (selectedTool === 'select' && selectedElement) {
      const element = track.elements.find(el => el.id === selectedElement);
      const curve = element && getRoadBezier(element);
      if (element && curve) {
        for (const key of ['start', 'control1', 'control2', 'end'] as const) {
          if (Math.hypot(point.x - curve[key].x, point.y - curve[key].y) < 10 / zoom) {
            setCurveDrag({ id: element.id, handle: key, original: track, curve });
            return;
          }
        }
      }
    }
    
    // First check if clicking on resize handles of currently selected element
    if (selectedElement && selectedTool === 'select') {
      const selectedEl = track.elements.find(el => el.id === selectedElement);
      if (selectedEl && hitTestElement(point, selectedEl)) {
        const corner = hitResizeCorner(point, selectedEl);
        if (corner) {
          // Handle resize of currently selected element
          setDragState({
            elementIds: [selectedEl.id],
            mode: 'resize',
            elementStartPositions: [{ id: selectedEl.id, x: selectedEl.x, y: selectedEl.y }],
            startPoint: point,
            offsetX: point.x - selectedEl.x,
            offsetY: point.y - selectedEl.y,
            corner: corner,
            originalSize: { width: selectedEl.width, height: selectedEl.height },
            isDragging: true,
          });
          setIsDrawing(false);
          setDrawPoints([]);
          return;
        }
      }
    }
    
    // Check for selection first (top-most element) - but only allow drag/resize with select tool
    for (let i = selectedTool === 'select' ? track.elements.length - 1 : -1; i >= 0; i--) {
      const el = track.elements[i]!;
      if (hideOtherLayers && (el.layer ?? 0) !== currentLayer) continue;
      if (!showRaceMarkers && (el.type === 'checkpoint' || el.type === 'spawn')) continue;
      if (hitTestElement(point, el)) {
        
        // Handle multi-select with Ctrl+click
        if (isCtrlClick && selectedTool === 'select') {
          if (selectedElements.includes(el.id)) {
            // Remove from multi-selection
            setSelectedElements(prev => prev.filter(id => id !== el.id));
            if (selectedElement === el.id) {
              // If removing the last selected element, set to the previous one or null
              const remaining = selectedElements.filter(id => id !== el.id);
              setSelectedElement(remaining[remaining.length - 1] ?? null);
            }
          } else {
            // Add to multi-selection
            setSelectedElements(prev => [...prev, el.id]);
            setSelectedElement(el.id); // Set as the "primary" selected element for properties
          }
        } else {
          // Normal single selection - just select the element, no immediate drag setup
          setSelectedElement(el.id);
          setSelectedElements([]);
          
          // Only setup drag for movement (not resize) when select tool is active
          if (selectedTool === 'select') {
            // For multi-select, prepare all selected elements for movement
            const elementsToMove = selectedElements.length > 0 ? selectedElements : [el.id];
            const startPositions = elementsToMove.map(id => {
              const element = track.elements.find(e => e.id === id);
              return element ? { id, x: element.x, y: element.y } : { id, x: 0, y: 0 };
            });
            
            setDragState({
              elementIds: elementsToMove,
              mode: 'move',
              elementStartPositions: startPositions,
              startPoint: point,
              offsetX: point.x - el.x,
              offsetY: point.y - el.y,
              isDragging: true,
            });
          }
        }
        
        setIsDrawing(false);
        setDrawPoints([]);
        return;
      }
    }
    
    // Special case for car and spawn tools - place immediately with fixed size
    if (selectedTool === 'car' || selectedTool === 'spawn') {
      addToHistory();
      const x = snapToGrid(point.x - 15); // Center on the click
      const y = snapToGrid(point.y - 25);
      
      const newElement: TrackElement = {
        id: `element-${Date.now()}`,
        type: selectedTool,
        x,
        y,
        position: { x, y },
        width: 30, // CAR_WIDTH from physics constants
        height: 50, // CAR_HEIGHT from physics constants
        rotation: 0,
        layer: currentLayer,
      };
      
      setTrack(prev => ({
        ...prev,
        elements: [...prev.elements, newElement]
      }));
      setSelectedElement(newElement.id);
      setSelectedElements([]); // Clear multi-selection
      expandCanvasIfNeeded(newElement);
      
      // Auto-switch to select tool if not pinned
      if (!pinnedTool) {
        setSelectedTool('select');
      }
      return;
    }
    
    // Don't create elements when select tool is active
    if (selectedTool === 'select') {
      // Clear multi-selection and select canvas if no element was clicked
      if (!isCtrlClick) {
        setSelectedElement('canvas');
        setSelectedElements([]);
      }
      return;
    }
    
    // Clear selection when using other tools
    setSelectedElement(null);
    setSelectedElements([]);
    
    setIsDrawing(true);
    const endpoint = selectedTool === 'road_curve' ? snapCurveEndpoint(point) : null;
    setDrawPoints([endpoint?.point ?? { x: snapToGrid(point.x), y: snapToGrid(point.y) }]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const point = getCanvasPoint(e);
    if (panDrag) {
      setPan({ x: panDrag.pan.x + e.clientX - panDrag.x, y: panDrag.pan.y + e.clientY - panDrag.y });
      return;
    }
    if (curveDrag) {
      if (!dragHasHistory.current) {
        addToHistory();
        dragHasHistory.current = true;
      }
      const element = track.elements.find(el => el.id === curveDrag.id);
      if (!element) return;
      const key = curveDrag.handle;
      const curve = { ...curveDrag.curve };
      const p = e.altKey ? point : { x: snapToGrid(point.x), y: snapToGrid(point.y) };
      curve[key] = p;
      if (key === 'start' || key === 'end') {
        const control = key === 'start' ? 'control1' : 'control2';
        curve[control] = {
          x: curveDrag.curve[control].x + p.x - curveDrag.curve[key].x,
          y: curveDrag.curve[control].y + p.y - curveDrag.curve[key].y,
        };
        const endpoint = e.altKey ? null : nearestRoadEndpoint(point,
          track.elements.filter(el => (el.layer ?? 0) === (element.layer ?? 0)),
          Math.min(80, 18 / zoom), element.id);
        reshapeCurve(element, endpointSnap && endpoint ? alignBezierEndpoint(curve, endpoint, key === 'start') : curve);
      } else {
        reshapeCurve(element, curve);
      }
      return;
    }
    
    // Update cursor for resize detection when not dragging
    if (!dragState && selectedTool === 'select' && selectedElement) {
      const element = track.elements.find(el => el.id === selectedElement);
      if (element) {
        const corner = hitResizeCorner(point, element);
        const canvas = canvasRef.current;
        if (canvas) {
          if (corner) {
            const rotation = element.rotation || 0;
            // Calculate the actual visual angle of the corner considering rotation
            let baseAngle = 0;
            if (corner === 'top-right') baseAngle = Math.PI / 4;      // 45°
            else if (corner === 'bottom-right') baseAngle = 3 * Math.PI / 4;  // 135°
            else if (corner === 'bottom-left') baseAngle = 5 * Math.PI / 4;   // 225°
            else if (corner === 'top-left') baseAngle = 7 * Math.PI / 4;      // 315°
            
            const actualAngle = (baseAngle + rotation) % (2 * Math.PI);
            const normalizedAngle = actualAngle < 0 ? actualAngle + 2 * Math.PI : actualAngle;
            
            // Determine cursor based on actual visual angle
            // nw-resize: 315° to 45° (top-left to top-right diagonal)
            // ne-resize: 45° to 135° (top-right to bottom-right diagonal)
            if ((normalizedAngle >= 7 * Math.PI / 4) || (normalizedAngle <= Math.PI / 4) ||
                (normalizedAngle >= 3 * Math.PI / 4 && normalizedAngle <= 5 * Math.PI / 4)) {
              canvas.style.cursor = 'nw-resize';
            } else {
              canvas.style.cursor = 'ne-resize';
            }
          } else {
            canvas.style.cursor = 'default';
          }
        }
      }
    }

    if (dragState && dragState.isDragging) {
      if (!dragHasHistory.current) {
        addToHistory();
        dragHasHistory.current = true;
      }
      if (dragState.mode === 'resize' && dragState.elementIds.length === 1) {
        // Handle resizing for single element
        const elementId = dragState.elementIds[0]!;
        const element = track.elements.find(el => el.id === elementId);
        if (element && dragState.corner && dragState.originalSize) {
          const rotation = element.rotation || 0;
          const deltaX = point.x - dragState.startPoint.x;
          const deltaY = point.y - dragState.startPoint.y;
          
          // Transform delta into element's local coordinate system if rotated
          let localDeltaX = deltaX;
          let localDeltaY = deltaY;
          if (rotation !== 0) {
            const cos = Math.cos(-rotation);
            const sin = Math.sin(-rotation);
            localDeltaX = deltaX * cos - deltaY * sin;
            localDeltaY = deltaX * sin + deltaY * cos;
          }
          
          let newX = element.x;
          let newY = element.y;
          let newWidth = element.width || 20;
          let newHeight = element.height || 20;
          
          // Calculate new dimensions based on resize corner using local coordinates
          if (dragState.corner.includes('right')) {
            newWidth = Math.max(10, dragState.originalSize.width + localDeltaX);
          }
          if (dragState.corner.includes('left')) {
            newWidth = Math.max(10, dragState.originalSize.width - localDeltaX);
          }
          if (dragState.corner.includes('bottom')) {
            newHeight = Math.max(10, dragState.originalSize.height + localDeltaY);
          }
          if (dragState.corner.includes('top')) {
            newHeight = Math.max(10, dragState.originalSize.height - localDeltaY);
          }
          
          // For curves, maintain square aspect ratio after calculating dimensions
          if (element.type === 'road_curve' && !element.properties?.bezier) {
            const size = Math.max(newWidth, newHeight);
            newWidth = size;
            newHeight = size;
          }
          
          // Calculate position changes for left/top edges in local space
          let localOffsetX = 0;
          let localOffsetY = 0;
          if (dragState.corner.includes('left')) {
            localOffsetX = dragState.originalSize.width - newWidth;
          }
          if (dragState.corner.includes('top')) {
            localOffsetY = dragState.originalSize.height - newHeight;
          }
          
          // Transform position offset back to world coordinates if rotated
          if (rotation !== 0 && (localOffsetX !== 0 || localOffsetY !== 0)) {
            const cos = Math.cos(rotation);
            const sin = Math.sin(rotation);
            const worldOffsetX = localOffsetX * cos - localOffsetY * sin;
            const worldOffsetY = localOffsetX * sin + localOffsetY * cos;
            newX = dragState.elementStartPositions[0]!.x + worldOffsetX;
            newY = dragState.elementStartPositions[0]!.y + worldOffsetY;
          } else if (localOffsetX !== 0 || localOffsetY !== 0) {
            // No rotation, simple offset
            newX = dragState.elementStartPositions[0]!.x + localOffsetX;
            newY = dragState.elementStartPositions[0]!.y + localOffsetY;
          }
          
          updateElement(elementId, cur => ({
            ...cur,
            x: snapToGrid(newX),
            y: snapToGrid(newY),
            width: newWidth,
            height: newHeight,
            position: { x: snapToGrid(newX), y: snapToGrid(newY) }
          }));
        }
      } else if (dragState.elementIds.length > 1) {
        // Multi-element drag - move all selected elements
        const deltaX = point.x - dragState.startPoint.x;
        const deltaY = point.y - dragState.startPoint.y;
        
        updateMultipleElements(dragState.elementIds, (element) => {
          const originalPosition = dragState.elementStartPositions.find(pos => pos.id === element.id);
          if (originalPosition) {
            const newX = snapToGrid(originalPosition.x + deltaX);
            const newY = snapToGrid(originalPosition.y + deltaY);
            return { ...element, x: newX, y: newY, position: { x: newX, y: newY } };
          }
          return element;
        });
        
      } else if (dragState.elementIds.length === 1) {
        // Single element drag
        const elementId = dragState.elementIds[0]!;
        const deltaX = point.x - dragState.startPoint.x;
        const deltaY = point.y - dragState.startPoint.y;
        
        const originalPosition = dragState.elementStartPositions.find(pos => pos.id === elementId);
        if (originalPosition) {
          const newX = snapToGrid(originalPosition.x + deltaX);
          const newY = snapToGrid(originalPosition.y + deltaY);
          updateElement(elementId, cur => ({ ...cur, x: newX, y: newY, position: { x: newX, y: newY } }));
        }
      }
      return;
    }

    if (!isDrawing || !drawPoints[0]) return;
    if (selectedTool === 'road_curve') {
      const endpoint = snapCurveEndpoint(point);
      setDrawPoints([drawPoints[0], endpoint?.point ?? { x: snapToGrid(point.x), y: snapToGrid(point.y) }]);
    } else {
      setDrawPoints([drawPoints[0], point]);
    }
  };

  const handleMouseUp = () => {
    if (panDrag) {
      setPanDrag(null);
      return;
    }
    if (curveDrag) {
      const element = track.elements.find(el => el.id === curveDrag.id);
      if (element) expandCanvasIfNeeded(element);
      setCurveDrag(null);
      return;
    }
    // Reset cursor
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = 'default';
    }
    
    if (dragState && dragState.isDragging) {
      // Handle multi-element drag completion
      if (dragState.elementIds.length > 0) {
        // Expand canvas if needed for any moved elements
        const movedElements = track.elements.filter(e => dragState.elementIds.includes(e.id));
        movedElements.forEach(element => expandCanvasIfNeeded(element));
        
        // Renumber checkpoints if any were moved
        setTrack(prev => ({ ...prev, elements: renumberCheckpoints(prev.elements) }));
      }
      
      setDragState(null);
      return;
    }
    if (isDrawing && drawPoints.length >= 2) {
      const start = drawPoints[0];
      const end = drawPoints[drawPoints.length - 1];
      
      if (!start || !end) {
        setIsDrawing(false);
        setDrawPoints([]);
        return;
      }
      if (selectedTool === 'road_curve') {
        if (Math.hypot(end.x - start.x, end.y - start.y) >= 20) {
          addToHistory();
          const newElement = makeCurve(start, end);
          setTrack(prev => ({ ...prev, elements: [...prev.elements, newElement] }));
          setSelectedElement(newElement.id);
          setSelectedElements([]);
          expandCanvasIfNeeded(newElement);
          if (!pinnedTool) setSelectedTool('select');
        }
        setIsDrawing(false);
        setDrawPoints([]);
        return;
      }
      
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const rawWidth = Math.abs(end.x - start.x) || gridSize;
      const rawHeight = Math.abs(end.y - start.y) || gridSize;
      let width, height;
      
      if (selectedTool === 'car') {
        // Car uses preset dimensions from physics constants
        width = 30; // CAR_WIDTH
        height = 50; // CAR_HEIGHT
      } else {
        width = rawWidth;
        height = rawHeight;
      }
      
      // Determine layer based on element type
      let elementLayer = currentLayer;
      if (selectedTool === 'bridge') {
        elementLayer = 1; // Bridges are always on layer 1
      } else if (selectedTool === 'ramp_up' || selectedTool === 'ramp_down') {
        elementLayer = 0; // Ramps start at ground level
      }
      
      const newElement: TrackElement = {
        id: `element-${Date.now()}`,
        type: selectedTool,
        x,
        y,
        position: { x, y },
        width,
        height,
        rotation: 0,
        layer: elementLayer,
        ...(selectedTool === 'finish' ? {
          properties: { finishVisibleWidth: width, finishVisibleOffset: 0 },
        } : {}),
      };
      addToHistory();

      if (selectedTool === 'checkpoint') {
        newElement.checkpointIndex = track.elements.filter(e => e.type === 'checkpoint').length;
      }

      setTrack(prev => {
        const elements = [...prev.elements, newElement];
        const updated = selectedTool === 'checkpoint' ? renumberCheckpoints(elements) : elements;
        return { ...prev, elements: updated };
      });
      setSelectedElement(newElement.id);
      setSelectedElements([]); // Clear multi-selection when creating new element
      expandCanvasIfNeeded(newElement);
      
      // Auto-switch to select tool if not pinned
      if (!pinnedTool) {
        setSelectedTool('select');
      }
    }
    
    setIsDrawing(false);
    setDrawPoints([]);
  };

  const handleDeleteElement = () => {
    if (!selectedElement) return;
    if (!confirm('Delete selected element?')) return;
    
    // Add current state to undo history before deletion
    addToHistory();
    
    setTrack(prev => {
      const remaining = prev.elements.filter(e => e.id !== selectedElement);
      return {
        ...prev,
        elements: renumberCheckpoints(remaining),
      };
    });
    setSelectedElement(null);
  };

  const handleDuplicateElement = () => {
    if (!selectedElement) return;
    const element = track.elements.find(e => e.id === selectedElement);
    if (!element) return;
    addToHistory();
    
    // Create a copy with new ID and offset position
    const duplicatedElement = {
      ...element,
      id: `element-${Date.now()}`,
      x: element.x + gridSize, // Offset by one grid unit
      y: element.y + gridSize,
      position: { x: element.x + gridSize, y: element.y + gridSize },
    };
    
    setTrack(prev => {
      const newElements = [...prev.elements, duplicatedElement];
      return {
        ...prev,
        elements: element.type === 'checkpoint' ? renumberCheckpoints(newElements) : newElements,
      };
    });
    setSelectedElement(duplicatedElement.id);
  };

  const handleSaveTrack = async () => {
    setSaveNotice(null);
    useNetworkStore.getState().clearError();
    try {
      // Filter out car elements since they're just visual references
      const trackToSave = {
        ...track,
        elements: track.elements.filter(e => e.type !== 'car')
      };
      const validation = validateTrack(trackToSave);
      if (!validation.isValid) {
        useNetworkStore.setState({
          error: `Cannot save track: ${validation.errors.map(error => error.message).join('; ')}`,
        });
        return;
      }
      
      const response = await fetch('/api/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trackToSave),
      });
      
      if (response.ok) {
        setSaveNotice('Track saved successfully.');
        requestTrackList();
      } else {
        const data = await response.json();
        const errorMessages = data.errors?.map((e: { message: string }) => e.message).join('; ')
          || data.error || `HTTP ${response.status}`;
        console.error('Failed to save track:', response.status, errorMessages);
        useNetworkStore.setState({ error: `Failed to save track: ${errorMessages}` });
      }
    } catch (error) {
      console.error('Error saving track:', error);
      useNetworkStore.setState({
        error: 'Unable to save track. Check the server connection and try Save again.',
      });
    }
  };

  const handleLoadTrack = async (trackId: string) => {
    useNetworkStore.getState().clearError();
    console.log('Loading track:', trackId);
    try {
      const response = await fetch(`/api/tracks/${trackId}`);
      console.log('Load track response status:', response.status);
      if (response.ok) {
        const trackData = await response.json();
        console.log('Loaded track data:', trackData.name, trackData.elements?.length, 'elements');
        setTrack(trackData);
        setSaveNotice(null);
        setSelectedElement(null);
        setSelectedElements([]);
        setUndoHistory([]);
        setRedoHistory([]);
      } else {
        console.error('Failed to load track, status:', response.status);
        const errorText = await response.text();
        console.error('Error response:', errorText);
        useNetworkStore.setState({
          error: response.status === 404
            ? 'Track not found. Please choose another track from Load.'
            : `Unable to load track (HTTP ${response.status}). The server may be restarting; please try Load again.`,
        });
      }
    } catch (error) {
      console.error('Failed to load track:', error);
      useNetworkStore.setState({
        error: 'Unable to load track. Check the server connection and try Load again.',
      });
    }
  };

  const handleNewTrack = () => {
    setSaveNotice(null);
    setTrack({
      ...DEFAULT_TRACK,
      id: `track-${Date.now()}`,
      name: 'New Track',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setSelectedElement(null);
    setSelectedElements([]);
    setUndoHistory([]);
    setRedoHistory([]);
  };

  const handleCreateTemplate = (copy: Track) => {
    setSaveNotice(null);
    addToHistory();
    setTrack(copy);
    setSelectedElement(null);
    setSelectedElements([]);
    setSelectedTool('select');
    setPinnedTool(null);
    setIsDrawing(false);
    setDrawPoints([]);
    setCurveDrag(null);
    setDragState(null);
    setCurrentLayer(0);
    const road = copy.elements.find(e => e.type === 'road_curve')!.properties!;
    setRoadWidth(road.roadWidth!);
    setCurveKerbs(road.kerbs ?? true);
    setShowTemplateDialog(false);
  };

  const handleDeleteCurrentTrack = async () => {
    if (!confirm(`Delete current track "${track.name}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/tracks/${track.id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        alert('Track deleted successfully!');
        requestTrackList();
        handleNewTrack(); // Load a new empty track
      } else {
        alert('Failed to delete track');
      }
    } catch (error) {
      console.error('Failed to delete track:', error);
      alert('Failed to delete track');
    }
  };

  const handleDeleteTrack = async (trackId: string, _trackName: string) => {
    if (!confirm('Delete selected track?')) {
      return;
    }

    try {
      const response = await fetch(`/api/tracks/${trackId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        alert('Track deleted successfully!');
        requestTrackList();
        // If we deleted the currently loaded track, create a new one
        if (track.id === trackId) {
          handleNewTrack();
        }
      } else {
        const data = await response.json();
        alert(`Failed to delete track: ${data.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error deleting track:', error);
      alert('Error deleting track');
    }
  };

  const handleExportTrack = async (trackId: string, trackName: string) => {
    try {
      const response = await fetch(`/api/tracks/${trackId}`);
      if (response.ok) {
        const trackData = await response.json();
        const blob = new Blob([JSON.stringify(trackData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${trackName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        alert('Failed to export track');
      }
    } catch (error) {
      console.error('Failed to export track:', error);
      alert('Failed to export track');
    }
  };

  const handleImportTrack = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const trackData = JSON.parse(text) as Track;
        // Validate track version
        const fileVersion = trackData.version ?? 0;
        if (fileVersion > CURRENT_TRACK_VERSION) {
          alert(`Cannot import track: version ${fileVersion} is not supported. Maximum supported version is ${CURRENT_TRACK_VERSION}.`);
          return;
        }
        const validation = validateTrack(trackData);
        if (!validation.isValid) {
          alert(`Cannot import track:\n${validation.errors.map(error => error.message).join('\n')}`);
          return;
        }
        // Assign a new ID, version, and timestamps so it's treated as a new track
        trackData.id = `track-${Date.now()}`;
        trackData.version = CURRENT_TRACK_VERSION;
        trackData.createdAt = Date.now();
        trackData.updatedAt = Date.now();
        setTrack(trackData);
        setSelectedElement(null);
        setSelectedElements([]);
        setUndoHistory([]);
        setRedoHistory([]);
      } catch (error) {
        console.error('Failed to import track:', error);
        alert('Failed to import track. Make sure the file is a valid track JSON.');
      }
    };
    input.click();
  };

  const handleCopyTrack = async (trackId: string) => {
    console.log('Copying track:', trackId);
    try {
      const response = await fetch(`/api/tracks/${trackId}`);
      console.log('Copy track fetch response status:', response.status);
      if (response.ok) {
        const trackData = await response.json();
        console.log('Fetched track for copy:', trackData.name);
        // Create a copy with new ID and modified name
        const newTrack = {
          ...trackData,
          id: `track-${Date.now()}`,
          name: `${trackData.name} (Copy)`,
          author: trackData.author === 'System' ? '' : trackData.author,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        console.log('Created copy with new ID:', newTrack.id);
        setTrack(newTrack);
        setSelectedElement(null);
        setSelectedElements([]);
        setUndoHistory([]);
        setRedoHistory([]);
      } else {
        console.error('Failed to fetch track for copy, status:', response.status);
        const errorText = await response.text();
        console.error('Error response:', errorText);
        alert('Failed to copy track');
      }
    } catch (error) {
      console.error('Failed to copy track:', error);
      alert('Failed to copy track');
    }
  };

  useEffect(() => {
    if (trackId) void handleLoadTrack(trackId);
  }, [trackId]);

  return (
    <div className="screen track-editor">
      <header className="header">
        <button className="btn btn-ghost" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h1>Track Editor</h1>
        <div className="header-actions">
          <button 
            className="btn btn-secondary" 
            onClick={handleUndo}
            disabled={undoHistory.length === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            ↶
          </button>
          <button className="btn btn-secondary" onClick={handleRedo}
            disabled={redoHistory.length === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            Redo
          </button>
          <button className="btn btn-secondary" onClick={handleNewTrack}>
            New
          </button>
          <button className="btn btn-secondary" onClick={() => setShowTemplateDialog(true)}>
            Templates
          </button>
          <button className="btn btn-secondary" onClick={() => setShowLoadDialog(true)}>
            Load
          </button>
          <button className="btn btn-secondary" onClick={handleImportTrack}>
            Import
          </button>
          <button className="btn btn-primary" onClick={handleSaveTrack}>
            Save
          </button>
          <button className="btn btn-error" onClick={handleDeleteCurrentTrack}>
            Delete
          </button>
        </div>
      </header>

      {saveNotice && <div className="editor-save-notice" role="status">
        <span>{saveNotice}</span>
        <button className="btn btn-ghost btn-small" onClick={() => setSaveNotice(null)}
          aria-label="Dismiss save notification">Dismiss</button>
      </div>}

      <div
        className="editor-layout"
        style={{
          gridTemplateColumns: `${leftCollapsed ? '24px ' : `${leftWidth}px `}1fr${rightCollapsed ? ' 24px' : ` ${rightWidth}px`}`.trim(),
        }}
      >
        {/* Toolbar */}
        {!leftCollapsed ? (
        <aside className="toolbar card" style={{ width: leftWidth }}>
          <div className="panel-header">
            <h3>Tools</h3>
            <button
              className="collapse-btn"
              onClick={() => setLeftCollapsed(true)}
              title="Collapse"
            >
              «
            </button>
          </div>
          <div className="tool-list">
            {ELEMENT_TYPES.map((tool, index) => {
              const shortcutKey = index === 9 ? '0' : String(index + 1);
              const isPinned = pinnedTool === tool.type;
              return (
                <button
                  key={tool.type}
                  className={`tool-btn ${selectedTool === tool.type ? 'active' : ''} ${isPinned ? 'pinned' : ''}`}
                  onClick={() => handleToolSelect(tool.type)}
                  onDoubleClick={() => {
                    if (isPinned) {
                      setPinnedTool(null);
                    } else {
                      setPinnedTool(tool.type);
                    }
                  }}
                  title={`${toolHints[tool.type]} (Shortcut: ${shortcutKey}, Double-click to pin)`}
                >
                  <div className="tool-content">
                    <span className="tool-icon">{tool.icon}</span>
                    <span className="tool-label">
                      {tool.label}
                      {isPinned && <span className="pin-icon">📌</span>}
                    </span>
                  </div>
                  <span className="tool-shortcut">{shortcutKey}</span>
                </button>
              );
            })}
          </div>

          {selectedTool === 'road_curve' && (
            <section className="curve-preset-section">
              <h4>Curve studio</h4>
              <div className="curve-preset-grid">
                {CURVE_PRESETS.map(preset => (
                  <button key={preset.id}
                    className={`preset-btn ${curvePreset === preset.id ? 'active' : ''}`}
                    onClick={() => setCurvePreset(preset.id)}
                    aria-pressed={curvePreset === preset.id}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <label className="curve-field">
                Road width
                <input className="input" type="number" min={40} max={600} step={10}
                  value={roadWidth} onChange={e => setRoadWidth(Math.max(40, Math.min(600, Number(e.target.value))))} />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={curveKerbs} onChange={e => setCurveKerbs(e.target.checked)} />
                Red / white kerbs
              </label>
              <p className="preset-hint">Drag from the road entry to its exit. Yellow dots snap to road ends and match their direction. Select the curve to drag its blue handles.</p>
            </section>
          )}

          <h3>Track Settings</h3>
          <div className="track-settings">
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                className="input"
                value={track.name}
                onChange={(e) => setTrack(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Author</label>
              <input
                type="text"
                className="input"
                value={track.author}
                onChange={(e) => setTrack(prev => ({ ...prev, author: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Difficulty</label>
              <select
                className="input"
                value={track.difficulty}
                onChange={(e) => setTrack(prev => ({ 
                  ...prev, 
                  difficulty: e.target.value as Track['difficulty']
                }))}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
                <option value="extreme">Extreme</option>
              </select>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={track.wrapAround ?? false}
                onChange={(e) => setTrack(prev => ({ 
                  ...prev, 
                  wrapAround: e.target.checked 
                }))}
              />
              Infinite Scroll (Wrap-around)
            </label>
          </div>

          <h3>Layer</h3>
          <div className="layer-options">
            <div className="form-group">
              <label>Current Layer</label>
              <select
                className="input"
                value={currentLayer}
                onChange={(e) => setCurrentLayer(Number(e.target.value))}
              >
                <option value={-1}>-1 (Tunnel)</option>
                <option value={0}>0 (Ground)</option>
                <option value={1}>1 (Bridge)</option>
                <option value={2}>2 (Upper Bridge)</option>
              </select>
            </div>
            <p className="layer-hint">
              Elements placed will be on this layer. Bridge elements auto-set to layer 1.
            </p>
          </div>

          <h3>View Options</h3>
          <div className="view-options">
            <label className="checkbox-label">
              <input type="checkbox" checked={showRaceMarkers} onChange={e => setShowRaceMarkers(e.target.checked)} />
              Show race markers
            </label>
            <label className="curve-field">
              Grid spacing
              <input className="input" type="number" min={5} max={100} step={5}
                value={gridSize} onChange={e => setGridSize(Math.max(5, Math.min(100, Number(e.target.value))))} />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={snapEnabled} onChange={e => setSnapEnabled(e.target.checked)} />
              Snap to grid
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={endpointSnap} onChange={e => setEndpointSnap(e.target.checked)} />
              Snap curve endpoints
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
              />
              Show Grid
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoExpandCanvas}
                onChange={(e) => setAutoExpandCanvas(e.target.checked)}
              />
              Auto-expand canvas
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={hideOtherLayers}
                onChange={(e) => setHideOtherLayers(e.target.checked)}
              />
              Show only current layer
            </label>
            <div className="form-group">
              <label>Zoom</label>
              <input
                type="range"
                min={minimumZoom}
                max="3"
                step="0.01"
                value={zoom}
                onChange={(e) => {
                  const nextZoom = Number(e.target.value);
                  setPan({
                    x: viewport.width / 2 - (viewport.width / 2 - pan.x) * nextZoom / zoom,
                    y: viewport.height / 2 - (viewport.height / 2 - pan.y) * nextZoom / zoom,
                  });
                  setZoom(nextZoom);
                }}
              />
            </div>
          </div>

          <div
            className="resize-handle right"
            onMouseDown={(e) => setResizingPanel({ panel: 'left', startX: e.clientX, startWidth: leftWidth })}
          />
        </aside>
        ) : (
          <div className="collapsed-tab" onClick={() => {
            setLeftCollapsed(false);
            if (window.innerWidth < 1000) setRightCollapsed(true);
          }} title="Expand tools" role="button" tabIndex={0} onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              setLeftCollapsed(false);
              if (window.innerWidth < 1000) setRightCollapsed(true);
            }
          }}>
            »
          </div>
        )}

        {/* Canvas */}
        <main className="canvas-container" ref={viewportRef}>
          <canvas
            ref={canvasRef}
            width={viewport.width}
            height={viewport.height}
            aria-label="Track editing canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
          <div className="canvas-navigation">
            <button className="btn btn-secondary btn-small" onClick={fitTrack}>Fit track (F)</button>
            <span>{Math.round(zoom * 100)}%</span>
            <span>Scroll to zoom · Space + drag to pan</span>
          </div>
        </main>

        {/* Properties Panel */}
        {!rightCollapsed ? (
        <aside className="properties-panel card" style={{ width: rightWidth }}>
          <div className="panel-header">
            <button
              className="collapse-btn"
              onClick={() => setRightCollapsed(true)}
              title="Collapse"
            >
              »
            </button>
            <span></span>
          </div>

          <div className="section-header" onClick={() => setShowSelectedSection(v => !v)}>
            <h3>Selected Element</h3>
            <span className="section-toggle">{showSelectedSection ? '−' : '+'}</span>
          </div>

          {showSelectedSection && selectedElements.length > 0 && (
            <div className="element-properties">
              <p>Type: Multiple Elements ({selectedElements.length} selected)</p>
              <p className="hint">Editing values will update all selected elements that support that property.</p>
              
              {(() => {
                const elements = track.elements.filter(e => selectedElements.includes(e.id));
                const commonProps = elements.reduce((props, element) => {
                  const elementProps = Object.keys(element);
                  return props.filter(prop => elementProps.includes(prop));
                }, Object.keys(elements[0] || {}));
                
                // Get common values for properties
                const getCommonValue = (prop: 'layer') => {
                  const values = elements.map(e => e[prop]);
                  const firstValue = values[0];
                  const allSame = values.every(v => v === firstValue);
                  return allSame ? firstValue : '';
                };
                
                return (
                  <>
                    {commonProps.includes('layer') && (
                      <div className="form-grid">
                        <label>
                          Layer (all)
                          <select
                            className="input"
                            value={getCommonValue('layer') ?? ''}
                            onChange={(e) => updateSelectedElements((element) => ({
                              ...element,
                              layer: Number(e.target.value)
                            }))}
                          >
                            <option value="">Mixed values</option>
                            <option value={-1}>-1 (Tunnel)</option>
                            <option value={0}>0 (Ground)</option>
                            <option value={1}>1 (Bridge)</option>
                            <option value={2}>2 (Upper Bridge)</option>
                          </select>
                        </label>
                      </div>
                    )}
                    
                    {commonProps.includes('rotation') && (
                      <div className="button-row">
                        <button
                          className="btn btn-secondary btn-small"
                          onClick={() => updateSelectedElements((element) => {
                            const updated = { ...element, rotation: (element.rotation || 0) - degToRad(15) };
                            updated.x = snapToGrid(updated.x);
                            updated.y = snapToGrid(updated.y);
                            return updated;
                          })}
                        >
                          Rotate All -15°
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          onClick={() => updateSelectedElements((element) => ({ ...element, rotation: 0 }))}
                        >
                          Reset All Rotation
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          onClick={() => updateSelectedElements((element) => {
                            const updated = { ...element, rotation: (element.rotation || 0) + degToRad(15) };
                            updated.x = snapToGrid(updated.x);
                            updated.y = snapToGrid(updated.y);
                            return updated;
                          })}
                        >
                          Rotate All +15°
                        </button>
                      </div>
                    )}
                    
                    <div className="button-row">
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={() => reorderSelectedElements('front')}
                      >
                        Bring to Front
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={() => reorderSelectedElements('back')}
                      >
                        Send to Back
                      </button>
                    </div>
                    
                    <div className="button-row">
                      <button 
                        className="btn btn-secondary" 
                        onClick={() => setSelectedElements([])}
                      >
                        Clear Selection
                      </button>
                      <button 
                        className="btn btn-error" 
                        onClick={() => {
                          if (confirm(`Delete ${selectedElements.length} selected elements?`)) {
                            addToHistory();
                            setTrack(prev => ({
                              ...prev,
                              elements: renumberCheckpoints(prev.elements.filter(e => !selectedElements.includes(e.id)))
                            }));
                            setSelectedElements([]);
                            setSelectedElement(null);
                          }
                        }}
                      >
                        Delete All Selected
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {showSelectedSection && selectedElement && selectedElements.length === 0 && (() => {
            if (selectedElement === 'canvas') {
              return (
                <div className="element-properties">
                  <p>Type: Canvas</p>
                  <p className="hint">Canvas dimensions. Elements placed near borders will auto-expand if enabled.</p>
                  <div className="form-grid">
                    <label>
                      Width
                      <input
                        type="number"
                        className="input"
                        min={800}
                        value={track.width}
                        onChange={(e) => setTrack(prev => ({ ...prev, width: Math.max(800, Number(e.target.value)) }))}
                      />
                    </label>
                    <label>
                      Height
                      <input
                        type="number"
                        className="input"
                        min={600}
                        value={track.height}
                        onChange={(e) => setTrack(prev => ({ ...prev, height: Math.max(600, Number(e.target.value)) }))}
                      />
                    </label>
                  </div>
                </div>
              );
            }
            
            const el = track.elements.find(e => e.id === selectedElement);
            if (!el) return null;
            return (
              <div className="element-properties" onFocus={e => {
                if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) addToHistory();
              }}>
                <p>Type: {el.type}</p>
                <p className="hint">{el.properties?.bezier
                  ? 'Yellow handles move the endpoints; blue handles shape the bend. Hold Alt for unsnapped precision.'
                  : 'Tip: Drag element to move. Drag bottom-right square to resize.'}</p>
                {(el.type === 'finish' || el.type === 'checkpoint') && (
                  <section className="curve-inspector">
                    <h3>Race gate</h3>
                    <p className="hint">
                      Cross in the arrow direction. Gates detect swept movement, not proximity.
                      Span the entire corridor, including grass, to prevent missed laps.
                    </p>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={el.properties?.autoGateWidth !== false}
                        onChange={e => {
                          addToHistory();
                          updateElement(el.id, cur => ({
                            ...cur, properties: { ...cur.properties, autoGateWidth: e.target.checked },
                          }));
                        }} />
                      Automatically span nearby barriers
                    </label>
                    <p>Detection width (including hidden parts): {Math.round(effectiveRaceGate(track, el).width)}</p>
                    {el.type === 'finish' && (
                      <>
                        <p className="hint">
                          The dashed cyan span counts laps even on grass. Checkerboard markings
                          are always clipped to asphalt on this layer. Width 0 hides all markings.
                        </p>
                        <label className="curve-field">
                          Visible marking width
                          <input className="input" type="number" min={0}
                            value={el.properties?.finishVisibleWidth ?? el.width}
                            onFocus={addToHistory}
                            onChange={e => updateElement(el.id, cur => ({
                              ...cur, properties: {
                                ...cur.properties,
                                finishVisibleWidth: Math.max(0, Number(e.target.value)),
                              },
                            }))} />
                        </label>
                        <label className="curve-field">
                          Visible marking offset
                          <input className="input" type="number"
                            value={el.properties?.finishVisibleOffset ?? 0}
                            onFocus={addToHistory}
                            onChange={e => updateElement(el.id, cur => ({
                              ...cur, properties: {
                                ...cur.properties, finishVisibleOffset: Number(e.target.value),
                              },
                            }))} />
                        </label>
                      </>
                    )}
                    {fitRaceGate(track, el) === el && (
                      <p className="hint">No nearby barrier pair. Set a manual width covering all drivable ground.</p>
                    )}
                    <button className="btn btn-secondary" disabled={fitRaceGate(track, el) === el} onClick={() => {
                      addToHistory();
                      const fitted = preserveFinishMarkings(el, fitRaceGate(track, el));
                      updateElement(el.id, () => ({
                        ...fitted, properties: { ...fitted.properties, autoGateWidth: false },
                      }));
                    }}>Fit width to barriers</button>
                  </section>
                )}
                {el.type === 'road_curve' && (
                  <section className="curve-inspector">
                    <h3>Curve shape</h3>
                    <label className="curve-field">
                      Road width
                      <input className="input" type="number" min={20} max={600}
                        value={Math.round(roadStrokeWidth(el))}
                        onChange={e => {
                          const width = Math.max(20, Math.min(600, Number(e.target.value)));
                          const curve = getRoadBezier(el);
                          if (curve) reshapeCurve(el, curve, width);
                          else updateElement(el.id, cur => ({ ...cur, properties: { ...cur.properties, roadWidth: width } }));
                        }} />
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={el.properties?.kerbs ?? false}
                        onChange={e => updateElement(el.id, cur => ({
                          ...cur, properties: { ...cur.properties, kerbs: e.target.checked },
                        }))} />
                      Red / white kerbs
                    </label>
                    {!el.properties?.bezier && (
                      <button className="btn btn-secondary" onClick={() => {
                        const ends = getRoadEndpoints(el);
                        const start = ends[0];
                        const end = ends[1];
                        if (!start || !end) return;
                        addToHistory();
                        reshapeCurve(el, {
                          start: start.point, end: end.point,
                          control1: { x: start.point.x - start.outward.x * el.width * 0.276142, y: start.point.y - start.outward.y * el.width * 0.276142 },
                          control2: { x: end.point.x - end.outward.x * el.width * 0.276142, y: end.point.y - end.outward.y * el.width * 0.276142 },
                        });
                      }}>Convert to editable curve</button>
                    )}
                    {el.properties?.bezier && (
                      <>
                        <div className="button-row">
                          <button className="btn btn-secondary btn-small" onClick={() => {
                            const curve = getRoadBezier(el);
                            if (!curve) return;
                            addToHistory();
                            reshapeCurve(el, presetBezier(curve.start, curve.end, 'custom'));
                          }}>Straighten</button>
                          <button className="btn btn-secondary btn-small" onClick={() => {
                            const curve = getRoadBezier(el);
                            if (!curve) return;
                            addToHistory();
                            reshapeCurve(el, { start: curve.end, control1: curve.control2, control2: curve.control1, end: curve.start });
                          }}>Reverse ends</button>
                        </div>
                        <p className="hint">Precise world coordinates</p>
                        {(['start', 'control1', 'control2', 'end'] as const).map(key => {
                          const curve = getRoadBezier(el);
                          if (!curve) return null;
                          return (
                            <div className="curve-coordinate" key={key}>
                              <span>{key === 'control1' ? 'Handle 1' : key === 'control2' ? 'Handle 2' : key}</span>
                              {(['x', 'y'] as const).map(axis => (
                                <label key={axis}>{axis.toUpperCase()}
                                  <input className="input" type="number" step={1}
                                    value={Math.round(curve[key][axis])}
                                    onChange={e => {
                                      const next = { ...curve, [key]: { ...curve[key], [axis]: Number(e.target.value) } };
                                      if (key === 'start' || key === 'end') {
                                        const control = key === 'start' ? 'control1' : 'control2';
                                        next[control] = { ...curve[control], [axis]: curve[control][axis] + next[key][axis] - curve[key][axis] };
                                      }
                                      reshapeCurve(el, next);
                                    }} />
                                </label>
                              ))}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </section>
                )}
                <div className="form-grid">
                  <label>
                    X
                    <input
                      type="number"
                      className="input"
                      value={el.x}
                      onChange={(e) => updateElement(el.id, cur => ({ ...cur, x: Number(e.target.value) }))}
                    />
                  </label>
                  <label>
                    Y
                    <input
                      type="number"
                      className="input"
                      value={el.y}
                      onChange={(e) => updateElement(el.id, cur => ({ ...cur, y: Number(e.target.value) }))}
                    />
                  </label>
                  <label>
                    Width
                    <input
                      type="number"
                      className="input"
                      min={5}
                      value={el.width}
                      onChange={(e) => updateElement(el.id, cur => ({ ...cur, width: Math.max(5, Number(e.target.value)) }))}
                    />
                  </label>
                  <label>
                    Height
                    <input
                      type="number"
                      className="input"
                      min={5}
                      value={el.height}
                      onChange={(e) => updateElement(el.id, cur => ({ ...cur, height: Math.max(5, Number(e.target.value)) }))}
                    />
                  </label>
                </div>

                <div className="form-grid">
                  <label>
                    Rotation (deg)
                    <input
                      type="number"
                      className="input"
                      value={Math.round(radToDeg(el.rotation || 0))}
                      onChange={(e) => {
                        const newRotation = degToRad(Number(e.target.value));
                        updateElement(el.id, cur => {
                          const updated = { ...cur, rotation: newRotation };
                          // Apply grid snapping to position after rotation
                          updated.x = snapToGrid(updated.x);
                          updated.y = snapToGrid(updated.y);
                          return updated;
                        });
                      }}
                    />
                  </label>
                  <label>
                    Layer
                    <select
                      className="input"
                      value={el.layer ?? 0}
                      onChange={(e) => updateElement(el.id, cur => ({ ...cur, layer: Number(e.target.value) }))}
                    >
                      <option value={-1}>-1 (Tunnel)</option>
                      <option value={0}>0 (Ground)</option>
                      <option value={1}>1 (Bridge)</option>
                      <option value={2}>2 (Upper Bridge)</option>
                    </select>
                  </label>
                </div>

                {el.type === 'checkpoint' && (
                  <label>
                    Checkpoint Order
                    <input
                      type="number"
                      className="input"
                      min={0}
                      value={el.checkpointIndex ?? 0}
                      onChange={(e) => setTrack(prev => ({
                        ...prev,
                        elements: renumberCheckpoints(prev.elements.map(cp => cp.id === el.id ? { ...cp, checkpointIndex: Number(e.target.value) } : cp)),
                      }))}
                    />
                  </label>
                )}

                <div className="button-row">
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => updateElement(el.id, cur => {
                      const updated = { ...cur, rotation: (cur.rotation || 0) - degToRad(15) };
                      updated.x = snapToGrid(updated.x);
                      updated.y = snapToGrid(updated.y);
                      return updated;
                    })}
                  >
                    Rotate -15°
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => updateElement(el.id, cur => ({ ...cur, rotation: 0 }))}
                  >
                    Reset Rotation
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => updateElement(el.id, cur => {
                      const updated = { ...cur, rotation: (cur.rotation || 0) + degToRad(15) };
                      updated.x = snapToGrid(updated.x);
                      updated.y = snapToGrid(updated.y);
                      return updated;
                    })}
                  >
                    Rotate +15°
                  </button>
                </div>

                <div className="button-row">
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => reorderSelectedElements('front')}
                  >
                    Bring to Front
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => reorderSelectedElements('back')}
                  >
                    Send to Back
                  </button>
                </div>

                <button className="btn btn-secondary" onClick={handleDuplicateElement}>
                  Duplicate Element
                </button>

                <button className="btn btn-error" onClick={handleDeleteElement}>
                  Delete Element
                </button>
              </div>
            );
          })()}

          <div
            className="resize-handle left"
            onMouseDown={(e) => setResizingPanel({ panel: 'right', startX: e.clientX, startWidth: rightWidth })}
          />
        </aside>
        ) : (
          <div className="collapsed-tab right" onClick={() => {
            setRightCollapsed(false);
            if (window.innerWidth < 1000) setLeftCollapsed(true);
          }} title="Expand properties" role="button" tabIndex={0} onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              setRightCollapsed(false);
              if (window.innerWidth < 1000) setLeftCollapsed(true);
            }
          }}>
            «
          </div>
        )}      </div>

      {/* Load Track Dialog */}
      {showTemplateDialog && <CircuitTemplateDialog onCreate={handleCreateTemplate}
        onClose={() => setShowTemplateDialog(false)} />}

      {showLoadDialog && (
        <div className="dialog-overlay" onClick={() => setShowLoadDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2>Load Track</h2>
              <button className="btn btn-ghost" onClick={() => setShowLoadDialog(false)}>
                ×
              </button>
            </div>
            <div className="dialog-content">
              <div className="track-list-editor">
                {trackList.map((t) => (
                  <div key={t.id} className="track-list-item-row">
                    <div className="track-list-item">
                      <strong>{t.name}</strong>
                      <small>by {t.author}</small>
                    </div>
                    <button
                      className="btn btn-primary btn-small"
                      onClick={() => {
                        handleLoadTrack(t.id);
                        setShowLoadDialog(false);
                      }}
                    >
                      Load
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => {
                        handleCopyTrack(t.id);
                        setShowLoadDialog(false);
                      }}
                    >
                      Copy
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => handleExportTrack(t.id, t.name)}
                    >
                      Export
                    </button>
                    {t.author !== 'System' && t.id !== 'default-oval' && (
                      <button
                        className="btn btn-error btn-small"
                        onClick={() => {
                          handleDeleteTrack(t.id, t.name);
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TrackEditor;
