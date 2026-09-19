import { useEffect, useRef, useCallback, useState } from 'react';
import * as PIXI from 'pixi.js';
import { RoomInfo, CarState, CAR_COLORS, Track, CarColor, PHYSICS_CONSTANTS } from '@shared';
import { useGameStore } from '../store/gameStore';
import { useNetworkStore } from '../store/networkStore';
import { debugLogger } from '../utils/debugLogger';
import { startRendererSession } from './rendererSession';

interface GameRendererProps {
  containerRef: React.RefObject<HTMLDivElement>;
  room: RoomInfo;
  localPlayerId: string | null;
}

function GameRenderer({ containerRef, room, localPlayerId }: GameRendererProps) {
  const appRef = useRef<PIXI.Application | null>(null);
  const renderLoopRef = useRef<() => void>(() => {});
  const carsRef = useRef<Map<string, PIXI.Container>>(new Map());
  const trackContainerRef = useRef<PIXI.Container | null>(null);
  const tireMarksContainerRef = useRef<PIXI.Container | null>(null);
  const cameraRef = useRef({ x: 0, y: 0 });
  const lastTimeRef = useRef<number>(performance.now());
  const debugCounterRef = useRef(0);
  const [pixiReady, setPixiReady] = useState(false);
  
  // Dynamic tile management for infinite scrolling
  const tilesContainerRef = useRef<PIXI.Container | null>(null);
  const renderedTilesRef = useRef<Map<string, PIXI.Container>>(new Map());
  const lastTileUpdateRef = useRef({ x: 0, y: 0 });
  
  // Track previous positions for tire marks
  const prevCarPositionsRef = useRef<Map<string, { x: number; y: number; rotation: number }>>(new Map());
  const tireMarkCountRef = useRef(0);
  const MAX_TIRE_MARKS = 100; // Limit total marks for performance
  
  const { interpolateCars } = useGameStore();
  const currentTrack = useNetworkStore(state => state.track);

  // Initialize PIXI
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setPixiReady(false);
    const app = new PIXI.Application();
    const onTick = () => renderLoopRef.current();
    let resizeFrame: number | null = null;
    const handleResize = () => {
      const rect = container.getBoundingClientRect();
      const width = rect.width || window.innerWidth;
      const height = rect.height || window.innerHeight;
      if (app.screen.width !== width || app.screen.height !== height) {
        app.renderer.resize(width, height);
      }
    };
    const scheduleResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        handleResize();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleResize);

    return startRendererSession({
      initialize: () => app.init({
        width: container.clientWidth || window.innerWidth,
        height: container.clientHeight || window.innerHeight,
        backgroundColor: 0x1a1a2e,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        autoStart: false,
      }),
      activate: () => {
        container.appendChild(app.canvas);
        app.canvas.style.width = '100%';
        app.canvas.style.height = '100%';
        app.canvas.style.display = 'block';
        appRef.current = app;
        const trackContainer = new PIXI.Container();
        app.stage.addChild(trackContainer);
        trackContainerRef.current = trackContainer;
        handleResize();
        resizeObserver.observe(container);
        window.addEventListener('resize', scheduleResize);
        lastTimeRef.current = performance.now();
        app.ticker.add(onTick);
        setPixiReady(true);
        app.ticker.start();
      },
      destroy: () => {
        app.ticker.remove(onTick);
        app.ticker.stop();
        resizeObserver.disconnect();
        window.removeEventListener('resize', scheduleResize);
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        app.destroy(true, { children: true });
        // A cancelled initialization must not clear a newer session's scene.
        if (appRef.current === app) {
          appRef.current = null;
          trackContainerRef.current = null;
          tilesContainerRef.current = null;
          tireMarksContainerRef.current = null;
          carsRef.current.clear();
          renderedTilesRef.current.clear();
          prevCarPositionsRef.current.clear();
          cameraRef.current = { x: 0, y: 0 };
        }
      },
      onError: error => {
        console.error('Failed to initialize game renderer:', error);
        useNetworkStore.setState({ error: 'Unable to initialize the game renderer. Please reload the page.' });
      },
    });
  }, [containerRef]);

  // Create a single tile at specified grid coordinates
  const createTile = useCallback((track: Track, tileX: number, tileY: number): PIXI.Container => {
    const tileContainer = new PIXI.Container();
    tileContainer.label = `tile_${tileX}_${tileY}`;
    
    // Tiles spaced at exact track dimensions (server wraps at track boundaries)
    const wrapCycleX = track.width;
    const wrapCycleY = track.height;
    const offsetX = tileX * wrapCycleX;
    const offsetY = tileY * wrapCycleY;
    
    // Draw background for entire tile
    const background = new PIXI.Graphics();
    background.rect(offsetX, offsetY, wrapCycleX, wrapCycleY);
    background.fill(0x1a1a2e);
    tileContainer.addChild(background);
    
    // Helper to draw an element at a position
    const drawElement = (element: typeof track.elements[0], baseX: number, baseY: number) => {
      const x = baseX;
      const y = baseY;
      const width = element.width || 100;
      const height = element.height || 100;
      const rotation = element.rotation || 0;
      const cx = x + width / 2;
      const cy = y + height / 2;
      
      const addRect = (fill: number, stroke?: number) => {
        const graphics = new PIXI.Graphics();
        graphics.rect(-width / 2, -height / 2, width, height);
        graphics.fill(fill);
        
        if (stroke) {
          const border = new PIXI.Graphics();
          border.rect(-width / 2, -height / 2, width, height);
          border.stroke({ color: stroke, width: 2, alpha: 0.8 });
          
          const containerWrap = new PIXI.Container();
          containerWrap.position.set(cx, cy);
          containerWrap.rotation = rotation;
          containerWrap.addChild(graphics, border);
          tileContainer.addChild(containerWrap);
        } else {
          graphics.position.set(cx, cy);
          graphics.rotation = rotation;
          tileContainer.addChild(graphics);
        }
      };

      switch (element.type) {
        case 'road': {
          addRect(0x666699);
          break;
        }
        case 'road_curve': {
          const g = new PIXI.Graphics();
          const radius = Math.min(width, height) / 2;
          g.stroke({ color: 0x3a3a5e, width: Math.min(width, height) * 0.6, alpha: 1 });
          g.arc(0, 0, radius * 0.8, -Math.PI / 2, 0);
          g.position.set(cx, cy);
          g.rotation = rotation;
          tileContainer.addChild(g);
          break;
        }
        case 'wall': {
          addRect(0x8B0000, 0xff4444);
          break;
        }
        case 'finish': {
          const finishContainer = new PIXI.Container();
          finishContainer.position.set(cx, cy);
          finishContainer.rotation = rotation;
          const squareSize = 10;
          for (let i = -width / 2; i < width / 2; i += squareSize) {
            for (let j = -height / 2; j < height / 2; j += squareSize) {
              const isWhite = (Math.floor((i + width / 2) / squareSize) + Math.floor((j + height / 2) / squareSize)) % 2 === 0;
              const square = new PIXI.Graphics();
              square.rect(i, j, squareSize, squareSize);
              square.fill(isWhite ? 0xffffff : 0x000000);
              finishContainer.addChild(square);
            }
          }
          tileContainer.addChild(finishContainer);
          break;
        }
        case 'checkpoint':
        case 'spawn':
          // Invisible - game logic only
          break;
        case 'boost_pad':
        case 'boost': {
          const graphics = new PIXI.Graphics();
          graphics.rect(-width / 2, -height / 2, width, height);
          graphics.fill({ color: 0x00ffff, alpha: 0.4 });
          const arrows = new PIXI.Graphics();
          arrows.moveTo(-15, 10);
          arrows.lineTo(0, -15);
          arrows.lineTo(15, 10);
          arrows.stroke({ color: 0x00ffff, width: 3 });
          const wrap = new PIXI.Container();
          wrap.position.set(cx, cy);
          wrap.rotation = rotation;
          wrap.addChild(graphics, arrows);
          tileContainer.addChild(wrap);
          break;
        }
        case 'oil_slick':
        case 'oil': {
          const graphics = new PIXI.Graphics();
          graphics.ellipse(0, 0, width / 2, height / 2);
          graphics.fill({ color: 0x1a1a1a, alpha: 0.7 });
          graphics.position.set(cx, cy);
          graphics.rotation = rotation;
          tileContainer.addChild(graphics);
          break;
        }
        case 'ramp': {
          addRect(0x8B4513);
          break;
        }
      }
    };
    
    // Draw elements - for wrap-around tracks, elements near edges need to be drawn
    // at multiple positions to fill the margin gap
    if (track.elements && track.elements.length > 0) {
      const sortedElements = [...track.elements].sort((a, b) => {
        const order: Record<string, number> = {
          road: 0,
          road_curve: 0,
          spawn: 1,
          checkpoint: 2,
          boost_pad: 3,
          boost: 3,
          oil_slick: 4,
          oil: 4,
          ramp: 5,
          finish: 6,
          wall: 7,
        };
        return (order[a.type] || 0) - (order[b.type] || 0);
      });

      sortedElements.forEach((element) => {
        const elX = element.x ?? element.position?.x ?? 0;
        const elY = element.y ?? element.position?.y ?? 0;
        const elWidth = element.width || 100;
        const elHeight = element.height || 100;
        
        // Draw element at its normal position within this tile
        drawElement(element, elX + offsetX, elY + offsetY);
        
        // For wrap-around tracks, also draw elements that wrap into the margin zone
        if (track.wrapAround) {
          const margin = PHYSICS_CONSTANTS.WRAP_MARGIN;
          
          // If element is near left edge, also draw it wrapped to the right (filling the margin)
          if (elX < margin) {
            drawElement(element, elX + track.width + offsetX, elY + offsetY);
          }
          // If element is near top edge, also draw it wrapped to the bottom
          if (elY < margin) {
            drawElement(element, elX + offsetX, elY + track.height + offsetY);
          }
          // Corner case: near both edges
          if (elX < margin && elY < margin) {
            drawElement(element, elX + track.width + offsetX, elY + track.height + offsetY);
          }
        }
      });
    }
    
    return tileContainer;
  }, []);

  // Update visible tiles based on camera position
  const updateVisibleTiles = useCallback((track: Track, cameraX: number, cameraY: number, screenWidth: number, screenHeight: number) => {
    if (!tilesContainerRef.current) return;
    
    // For non-wrap-around tracks, just draw once
    if (!track.wrapAround) {
      const tileKey = '0_0';
      if (!renderedTilesRef.current.has(tileKey)) {
        const tile = createTile(track, 0, 0);
        tilesContainerRef.current.addChildAt(tile, 0);
        renderedTilesRef.current.set(tileKey, tile);
      }
      return;
    }
    
    // Calculate visible tile range based on camera position
    // Add padding to ensure tiles are loaded before they become visible
    const padding = Math.max(screenWidth, screenHeight);
    const viewLeft = cameraX - screenWidth / 2 - padding;
    const viewRight = cameraX + screenWidth / 2 + padding;
    const viewTop = cameraY - screenHeight / 2 - padding;
    const viewBottom = cameraY + screenHeight / 2 + padding;
    
    // Convert to tile coordinates (tiles spaced at wrap cycle = track + margin)
    const wrapCycleX = track.width;
    const wrapCycleY = track.height;
    const minTileX = Math.floor(viewLeft / wrapCycleX);
    const maxTileX = Math.floor(viewRight / wrapCycleX);
    const minTileY = Math.floor(viewTop / wrapCycleY);
    const maxTileY = Math.floor(viewBottom / wrapCycleY);
    
    // Track which tiles should be visible
    const visibleTileKeys = new Set<string>();
    
    // Create tiles that should be visible
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        const tileKey = `${tx}_${ty}`;
        visibleTileKeys.add(tileKey);
        
        if (!renderedTilesRef.current.has(tileKey)) {
          const tile = createTile(track, tx, ty);
          tilesContainerRef.current.addChildAt(tile, 0); // Add at bottom
          renderedTilesRef.current.set(tileKey, tile);
        }
      }
    }
    
    // Remove tiles that are no longer visible (with extra buffer to prevent flicker)
    const removalPadding = padding * 2;
    const removeLeft = cameraX - screenWidth / 2 - removalPadding;
    const removeRight = cameraX + screenWidth / 2 + removalPadding;
    const removeTop = cameraY - screenHeight / 2 - removalPadding;
    const removeBottom = cameraY + screenHeight / 2 + removalPadding;
    
    renderedTilesRef.current.forEach((tile, key) => {
      const [txStr, tyStr] = key.split('_');
      const tx = parseInt(txStr!, 10);
      const ty = parseInt(tyStr!, 10);
      const tileCenterX = (tx + 0.5) * wrapCycleX;
      const tileCenterY = (ty + 0.5) * wrapCycleY;
      
      if (tileCenterX < removeLeft || tileCenterX > removeRight ||
          tileCenterY < removeTop || tileCenterY > removeBottom) {
        tilesContainerRef.current!.removeChild(tile);
        tile.destroy({ children: true });
        renderedTilesRef.current.delete(key);
      }
    });
  }, [createTile]);

  // Render loop
  const renderLoop = useCallback(() => {
    // Exit early if destroyed or not properly initialized
    if (!appRef.current || !trackContainerRef.current || !tilesContainerRef.current) return;

    // Calculate delta time
    const currentTime = performance.now();
    let deltaTime = (currentTime - lastTimeRef.current) / 1000;
    lastTimeRef.current = currentTime;

    // Clamp deltaTime to prevent issues with large time gaps (e.g., tab switching)
    if (deltaTime > 0.1) {
      deltaTime = 0.016; // Default to ~60fps
    }

    // Interpolate car positions for smooth display
    interpolateCars(deltaTime);

    const { cars: currentCars } = useGameStore.getState();
    const screenWidth = appRef.current.renderer.width;
    const screenHeight = appRef.current.renderer.height;

    // Update camera to follow local player
    if (localPlayerId && currentCars.has(localPlayerId)) {
      const localCar = currentCars.get(localPlayerId)!;
      const targetX = localCar.displayPosition.x;
      const targetY = localCar.displayPosition.y;
      
      // Validate target position
      if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
        console.error('Invalid car displayPosition for camera:', { targetX, targetY, playerId: localPlayerId });
      } else {
        // displayPosition is in continuous (unwrapped) space for the local player,
        // so camera simply follows it with lerp. No wrap detection needed.
        if (cameraRef.current.x === 0 && cameraRef.current.y === 0) {
          // First frame: snap camera to car position
          cameraRef.current.x = targetX;
          cameraRef.current.y = targetY;
        } else {
          // Smooth camera follow (frame-rate-independent)
          const lerpFactor = 1 - Math.pow(0.9, deltaTime * 60);
          cameraRef.current.x += (targetX - cameraRef.current.x) * lerpFactor;
          cameraRef.current.y += (targetY - cameraRef.current.y) * lerpFactor;
        }
      }
    }

    // Validate camera position (clamp to reasonable bounds)
    // If out of bounds, try to reset to spawn element or track center
    const getResetPosition = () => {
      const spawnElements = currentTrack?.elements?.filter(el => el.type === 'spawn') || [];
      if (spawnElements.length > 0) {
        const spawn = spawnElements[0]!;
        return { x: spawn.x + spawn.width / 2, y: spawn.y + spawn.height / 2 };
      }
      if (currentTrack) {
        return { x: currentTrack.width / 2, y: currentTrack.height / 2 };
      }
      return { x: 0, y: 0 };
    };
    
    if (!Number.isFinite(cameraRef.current.x) || Math.abs(cameraRef.current.x) > 1000000) {
      console.error('Camera X out of bounds, resetting:', cameraRef.current.x);
      const reset = getResetPosition();
      cameraRef.current.x = reset.x;
      cameraRef.current.y = reset.y;
    }
    if (!Number.isFinite(cameraRef.current.y) || Math.abs(cameraRef.current.y) > 1000000) {
      console.error('Camera Y out of bounds, resetting:', cameraRef.current.y);
      const reset = getResetPosition();
      cameraRef.current.x = reset.x;
      cameraRef.current.y = reset.y;
    }

    // Apply camera transform
    trackContainerRef.current.x = screenWidth / 2 - cameraRef.current.x;
    trackContainerRef.current.y = screenHeight / 2 - cameraRef.current.y;
    
    // Update visible tiles for infinite scrolling (only check periodically for performance)
    if (currentTrack) {
      const tileMoveThreshold = 50; // Only update tiles when camera moves significantly
      const dx = Math.abs(cameraRef.current.x - lastTileUpdateRef.current.x);
      const dy = Math.abs(cameraRef.current.y - lastTileUpdateRef.current.y);
      
      if (dx > tileMoveThreshold || dy > tileMoveThreshold || renderedTilesRef.current.size === 0) {
        updateVisibleTiles(currentTrack, cameraRef.current.x, cameraRef.current.y, screenWidth, screenHeight);
        lastTileUpdateRef.current = { x: cameraRef.current.x, y: cameraRef.current.y };
      }
    }
    
    // Debug log the camera transform
    if (debugCounterRef.current % 300 === 0) { // Reduced frequency
      debugLogger.log('CAMERA', 'Camera transform applied', {
        screenSize: { width: screenWidth, height: screenHeight },
        cameraPos: { x: cameraRef.current.x, y: cameraRef.current.y },
        containerPos: { x: trackContainerRef.current.x, y: trackContainerRef.current.y },
        canvasSize: { 
          width: appRef.current.canvas.width, 
          height: appRef.current.canvas.height,
          styleWidth: appRef.current.canvas.style.width,
          styleHeight: appRef.current.canvas.style.height
        },
        rendererSize: {
          width: appRef.current.renderer.width,
          height: appRef.current.renderer.height
        },
        worldToScreen: {
          example: `World (${cameraRef.current.x}, ${cameraRef.current.y}) → Screen (${screenWidth / 2}, ${screenHeight / 2})`
        }
      });
    }

    // Debug log every 60 frames (~1 second)
    debugCounterRef.current++;
    if (debugCounterRef.current % 300 === 0) { // Reduced frequency from 60 to 300 frames
      debugLogger.log('RENDER', 'Render state', {
        carsInStore: currentCars.size,
        carsSprites: carsRef.current.size,
        trackChildren: trackContainerRef.current.children.length,
        camera: { x: cameraRef.current.x.toFixed(0), y: cameraRef.current.y.toFixed(0) },
        containerPos: { x: trackContainerRef.current.x.toFixed(0), y: trackContainerRef.current.y.toFixed(0) },
        screen: { w: screenWidth, h: screenHeight },
        localPlayerId,
        hasLocalCar: localPlayerId ? currentCars.has(localPlayerId) : false,
      });
    }

    // Update car sprites
    currentCars.forEach((carData, id) => {
      let carContainer = carsRef.current.get(id);
      
      if (!carContainer) {
        carContainer = createCarSprite(carData);
        trackContainerRef.current!.addChild(carContainer);
        carsRef.current.set(id, carContainer);
      }

      // For wrap-around tracks, position cars relative to the continuous camera.
      // Local player: displayPosition is already continuous (from prediction), no adjustment needed.
      // Remote players: server sends wrapped positions [0, w)×[0, h), find the copy closest to camera.
      let carX = carData.displayPosition.x;
      let carY = carData.displayPosition.y;
      
      if (currentTrack?.wrapAround && id !== localPlayerId) {
        // Remote cars: find the copy closest to camera using Math.round
        const w = currentTrack.width;
        const h = currentTrack.height;
        const kx = Math.round((cameraRef.current.x - carX) / w);
        const ky = Math.round((cameraRef.current.y - carY) / h);
        carX += kx * w;
        carY += ky * h;
      }

      // Update position and rotation
      carContainer.x = carX;
      carContainer.y = carY;
      carContainer.rotation = carData.displayRotation;

      // Update front wheel rotation based on steering
      // For local player, use current input for immediate response
      // For remote players, use the server-synced steering angle
      const { currentInput } = useGameStore.getState();
      const isLocalPlayer = id === localPlayerId;
      const steerAngle = isLocalPlayer ? (currentInput.steerValue || 0) : (carData.steeringAngle || 0);
      
      carContainer.children.forEach(child => {
        if (child.label === 'frontWheel0' || child.label === 'frontWheel1') {
          (child as PIXI.Container).rotation = steerAngle * 0.4; // Max ~23 degree visual turn
        }
      });

      // Update visibility
      carContainer.visible = true;
      
      // === TIRE MARKS ===
      if (tireMarksContainerRef.current) {
        const prevPos = prevCarPositionsRef.current.get(id);
        // Use the adjusted continuous position for wrap-around tracks
        const currentPos = {
          x: carX,
          y: carY,
          rotation: carData.displayRotation,
        };
        
        if (prevPos) {
          // Calculate car's forward direction
          const forwardX = Math.sin(currentPos.rotation);
          const forwardY = -Math.cos(currentPos.rotation);
          
          // Calculate velocity direction from position change
          const dx = currentPos.x - prevPos.x;
          const dy = currentPos.y - prevPos.y;
          const speed = Math.sqrt(dx * dx + dy * dy);
          
          // Only draw marks if car is moving
          if (speed > 0.5) {
            // Calculate how much the car is sliding (lateral velocity)
            // Dot product of velocity with perpendicular to forward direction
            const perpX = -forwardY;
            const perpY = forwardX;
            const lateralVelocity = Math.abs(dx * perpX + dy * perpY);
            
            // Also check angular velocity (spinning)
            const rotationChange = Math.abs(currentPos.rotation - prevPos.rotation);
            
            // Check if handbraking (from local player input)
            const isHandbraking = isLocalPlayer && currentInput.handbrake;
            
            // Calculate skid intensity (0-1)
            // Higher when: lateral sliding, spinning, handbraking, or during sharp turns at speed
            let skidIntensity = 0;
            
            // Lateral sliding contribution
            if (speed > 0) {
              skidIntensity += (lateralVelocity / speed) * 0.8;
            }
            
            // Rotation contribution (spinning)
            skidIntensity += Math.min(rotationChange * 3, 0.4);
            
            // Handbrake bonus
            if (isHandbraking && speed > 2) {
              skidIntensity += 0.5;
            }
            
            // Sharp turn at speed
            const turnIntensity = Math.abs(steerAngle) * speed * 0.02;
            skidIntensity += Math.min(turnIntensity, 0.3);
            
            // Clamp to 0-1
            skidIntensity = Math.min(1, Math.max(0, skidIntensity));
            
            // Draw tire marks if skid intensity is significant
            if (skidIntensity > 0.15) {
              // Wheel positions relative to car center
              const wheelOffsets = [
                { x: -15, y: 18 },  // Rear left
                { x: 15, y: 18 },   // Rear right
              ];
              
              // Transform wheel positions to world coordinates
              const cos = Math.cos(currentPos.rotation);
              const sin = Math.sin(currentPos.rotation);
              
              wheelOffsets.forEach(offset => {
                // FIFO: ensure capacity before adding new marks
                while (tireMarkCountRef.current >= MAX_TIRE_MARKS && tireMarksContainerRef.current!.children.length > 0) {
                  const oldest = tireMarksContainerRef.current!.children[0];
                  tireMarksContainerRef.current!.removeChild(oldest);
                  oldest.destroy();
                  tireMarkCountRef.current--;
                }

                const worldX = currentPos.x + offset.x * cos - offset.y * sin;
                const worldY = currentPos.y + offset.x * sin + offset.y * cos;
                
                const prevWorldX = prevPos.x + offset.x * Math.cos(prevPos.rotation) - offset.y * Math.sin(prevPos.rotation);
                const prevWorldY = prevPos.y + offset.x * Math.sin(prevPos.rotation) + offset.y * Math.cos(prevPos.rotation);
                
                // Draw tire mark
                const mark = new PIXI.Graphics();
                mark.moveTo(prevWorldX, prevWorldY);
                mark.lineTo(worldX, worldY);
                
                // Darker and thicker marks for harder skids
                const alpha = 0.2 + skidIntensity * 0.5;
                const width = 2 + skidIntensity * 4;
                mark.stroke({ color: 0x1a1a1a, width, alpha });
                
                tireMarksContainerRef.current!.addChild(mark);
                tireMarkCountRef.current++;
              });
            }
          }
        }
        
        // Update previous position
        prevCarPositionsRef.current.set(id, currentPos);
      }
    });

    // Remove cars that are no longer in the game
    carsRef.current.forEach((container, id) => {
      if (!currentCars.has(id)) {
        trackContainerRef.current!.removeChild(container);
        container.destroy();
        carsRef.current.delete(id);
      }
    });
  }, [localPlayerId, interpolateCars, updateVisibleTiles, currentTrack]);

  useEffect(() => {
    renderLoopRef.current = renderLoop;
  }, [renderLoop]);

  // Create car sprite
  const createCarSprite = (carData: CarState): PIXI.Container => {
    const container = new PIXI.Container();
    
    const player = room.players.find((p) => p.id === carData.playerId);
    const colorData = player ? CAR_COLORS[player.color as CarColor] : CAR_COLORS.red;
    const color = parseInt(colorData?.hex?.replace('#', '') || 'ff0000', 16);

    // Car body
    const body = new PIXI.Graphics();
    body.roundRect(-15, -25, 30, 50, 5);
    body.fill(color);
    container.addChild(body);

    // Windshield
    const windshield = new PIXI.Graphics();
    windshield.roundRect(-10, -15, 20, 15, 3);
    windshield.fill(0x1a1a2e);
    container.addChild(windshield);

    // Rear wheels (static)
    const rearWheelPositions = [
      { x: -15, y: 18 },
      { x: 15, y: 18 },
    ];

    rearWheelPositions.forEach(pos => {
      const wheel = new PIXI.Graphics();
      wheel.roundRect(-3, -5, 6, 10, 2);
      wheel.fill(0x1a1a1a);
      wheel.x = pos.x;
      wheel.y = pos.y;
      container.addChild(wheel);
    });

    // Front wheels (will rotate with steering)
    const frontWheelPositions = [
      { x: -15, y: -18 },
      { x: 15, y: -18 },
    ];

    frontWheelPositions.forEach((pos, index) => {
      const wheelContainer = new PIXI.Container();
      wheelContainer.x = pos.x;
      wheelContainer.y = pos.y;
      
      const wheel = new PIXI.Graphics();
      wheel.roundRect(-3, -5, 6, 10, 2);
      wheel.fill(0x1a1a1a);
      wheelContainer.addChild(wheel);
      
      // Tag for identification
      wheelContainer.label = `frontWheel${index}`;
      container.addChild(wheelContainer);
    });

    // Headlights
    const headlight1 = new PIXI.Graphics();
    headlight1.circle(-8, -23, 3);
    headlight1.fill(0xffffcc);
    container.addChild(headlight1);

    const headlight2 = new PIXI.Graphics();
    headlight2.circle(8, -23, 3);
    headlight2.fill(0xffffcc);
    container.addChild(headlight2);

    // Taillights
    const taillight1 = new PIXI.Graphics();
    taillight1.roundRect(-12, 20, 6, 4, 1);
    taillight1.fill(0xff0000);
    container.addChild(taillight1);

    const taillight2 = new PIXI.Graphics();
    taillight2.roundRect(6, 20, 6, 4, 1);
    taillight2.fill(0xff0000);
    container.addChild(taillight2);

    // Player name
    const nameText = new PIXI.Text({
      text: player?.nickname || 'Player',
      style: {
        fontSize: 12,
        fill: 0xffffff,
        fontFamily: 'Inter, sans-serif',
        stroke: { color: 0x000000, width: 2 },
      },
    });
    nameText.anchor.set(0.5, 0.5);
    nameText.y = -40;
    container.addChild(nameText);

    return container;
  };

  // Draw track when it changes or when PIXI becomes ready
  useEffect(() => {
    console.log('🎮 CLIENT DEBUG: Track effect triggered', {
      pixiReady,
      hasContainer: !!trackContainerRef.current,
      hasTrack: !!currentTrack,
      trackName: currentTrack?.name,
      trackSpawnElements: currentTrack?.elements?.filter(el => el.type === 'spawn')?.length || 0
    });
    
    if (!pixiReady || !trackContainerRef.current || !currentTrack) return;

    // Clear existing track elements (except cars)
    const carContainers = Array.from(carsRef.current.values());
    trackContainerRef.current.removeChildren();
    
    // Reset camera offset for new track
    lastTileUpdateRef.current = { x: 0, y: 0 };
    renderedTilesRef.current.clear();
    
    // Initialize camera to track center or spawn element
    if (cameraRef.current.x === 0 && cameraRef.current.y === 0) {
      const spawnElements = currentTrack.elements?.filter(el => el.type === 'spawn') || [];
      if (spawnElements.length > 0) {
        const spawn = spawnElements[0]!;
        cameraRef.current.x = spawn.x + spawn.width / 2;
        cameraRef.current.y = spawn.y + spawn.height / 2;
        // Camera initialized to spawn element
      } else {
        cameraRef.current.x = currentTrack.width / 2;
        cameraRef.current.y = currentTrack.height / 2;
        // Camera initialized to track center
      }
    }
    
    // Create tiles container for dynamic tile management
    const tilesContainer = new PIXI.Container();
    tilesContainer.label = 'tilesContainer';
    trackContainerRef.current.addChild(tilesContainer);
    tilesContainerRef.current = tilesContainer;
    
    // Create tire marks container (above track, below cars)
    const tireMarksContainer = new PIXI.Container();
    tireMarksContainer.label = 'tireMarks';
    trackContainerRef.current.addChild(tireMarksContainer);
    tireMarksContainerRef.current = tireMarksContainer;
    tireMarkCountRef.current = 0;
    prevCarPositionsRef.current.clear();
    
    // Re-add car containers on top
    carContainers.forEach(car => trackContainerRef.current!.addChild(car));
    
    // Track drawn
  }, [currentTrack, pixiReady]);

  return null; // Render happens in PIXI
}

export default GameRenderer;
