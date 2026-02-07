import { useEffect, useRef } from 'react';
import { RoomInfo, CAR_COLORS, CarColor, PHYSICS_CONSTANTS, Track } from '@shared';
import { useGameStore } from '../store/gameStore';
import { useNetworkStore } from '../store/networkStore';
import './GameHUD.css';

interface GameHUDProps {
  room: RoomInfo;
  localPlayerId: string | null;
  raceTimer: number;
  showMinimap: boolean;
}

function GameHUD({ room, localPlayerId, raceTimer, showMinimap }: GameHUDProps) {
  const { cars } = useGameStore();
  const currentTrack = useNetworkStore(state => state.track);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const localPlayer = room.players.find((p) => p.id === localPlayerId);
  const localCar = localPlayerId ? cars.get(localPlayerId) : null;
  const baseMaxSpeed = PHYSICS_CONSTANTS.MAX_SPEED;
  const nitroMaxSpeed = baseMaxSpeed * PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER;
  const SPEED_TO_KMH = 3.6;

  // Sort players by position (lap + checkpoint progress)
  const sortedPlayers = [...room.players].sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.lap !== b.lap) return b.lap - a.lap;
    return b.checkpointIndex - a.checkpointIndex;
  });

  const localPosition = sortedPlayers.findIndex(p => p.id === localPlayerId) + 1;

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = Math.floor((ms % 1000) / 10);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(2, '0')}`;
  };

  const getPositionSuffix = (pos: number) => {
    if (pos === 1) return 'st';
    if (pos === 2) return 'nd';
    if (pos === 3) return 'rd';
    return 'th';
  };

  return (
    <div className="game-hud">
      {/* Top left - Race info */}
      <div className="hud-top-left">
        <div className="position-display">
          <span className="position-number">{localPosition}</span>
          <span className="position-suffix">{getPositionSuffix(localPosition)}</span>
          <span className="position-total">/ {room.players.length}</span>
        </div>
        
        <div className="lap-display">
          <span className="lap-label">LAP</span>
          <span className="lap-current">{localPlayer?.lap || 0}</span>
          <span className="lap-separator">/</span>
          <span className="lap-total">{room.lapCount}</span>
        </div>
      </div>

      {/* Top center - Timer */}
      <div className="hud-top-center">
        <div className="timer-display">
          {formatTime(raceTimer)}
        </div>
        {localPlayer?.bestLapTime && (
          <div className="best-lap">
            Best: {formatTime(localPlayer.bestLapTime)}
          </div>
        )}
      </div>

      {/* Top right - Leaderboard */}
      <div className="hud-top-right">
        <div className="mini-leaderboard">
          {sortedPlayers.slice(0, 5).map((player, index) => (
            <div 
              key={player.id} 
              className={`leaderboard-entry ${player.id === localPlayerId ? 'local' : ''}`}
            >
              <span className="entry-position">{index + 1}</span>
              <div 
                className="entry-color"
                style={{ backgroundColor: CAR_COLORS[player.color as CarColor]?.hex || '#888' }}
              />
              <span className="entry-name">
                {player.nickname.length > 10 
                  ? player.nickname.slice(0, 10) + '...' 
                  : player.nickname
                }
              </span>
              {player.finished && <span className="finished-flag">🏁</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom left - Speed/Controls hint */}
      <div className="hud-bottom-left">
        <div className="controls-hint">
          <span>WASD / Arrows to drive</span>
          <span>SPACE for boost</span>
          <span>R to respawn</span>
        </div>
        
        {/* Nitro Gauge */}
        {localCar && (
          <div className="nitro-gauge">
            <span className="nitro-label">NITRO</span>
            <div className="nitro-bar-container">
              <div 
                className="nitro-bar-fill"
                style={{ 
                  width: `${(localCar.nitroAmount / PHYSICS_CONSTANTS.NITRO_MAX) * 100}%`,
                  backgroundColor: localCar.nitroAmount > 20 ? '#00d9ff' : '#ff4444'
                }}
              />
            </div>
          </div>
        )}

        {/* Speed Meter */}
        {localCar && (
          <div className="speed-meter">
            <div className="speed-header">
              <span className="speed-label">SPEED</span>
            </div>
            <div className="speed-bar-container">
              <div 
                className={`speed-bar-fill ${localCar.speed > baseMaxSpeed ? 'overcap' : ''}`}
                style={{ width: `${Math.min(1, localCar.speed / nitroMaxSpeed) * 100}%` }}
              />
              <div 
                className="speed-bar-threshold"
                style={{ left: `${(baseMaxSpeed / nitroMaxSpeed) * 100}%` }}
                title="Normal top speed"
              />
            </div>
          </div>
        )}
      </div>

      {/* Minimap */}
      {showMinimap && currentTrack && (
        <div className="hud-minimap">
          <div className="minimap-title">TRACK MAP</div>
          <div className="minimap-container">
            <MinimapCanvas track={currentTrack} cars={cars} players={room.players} localPlayerId={localPlayerId} />
          </div>
        </div>
      )}
    </div>
  );
}

// Separate minimap component to handle canvas drawing
function MinimapCanvas({ track, cars, players, localPlayerId }: {
  track: Track;
  cars: Map<string, any>;
  players: any[];
  localPlayerId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !track) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const minimapSize = 150;
    const minimapRadius = minimapSize / 2;
    
    // Clear canvas
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, minimapSize, minimapSize);
    
    // Get local player position for centering
    const localCar = localPlayerId ? cars.get(localPlayerId) : null;
    let localPos = localCar?.displayPosition || { x: track.width / 2, y: track.height / 2 };
    
    // For wrap-around tracks, normalize localPos to the standard track range
    // This ensures proper relative positioning with server-sent remote player positions
    if (track.wrapAround) {
      const wrapCycleX = track.width;
      const wrapCycleY = track.height;
      let normalizedX = ((localPos.x % wrapCycleX) + wrapCycleX) % wrapCycleX;
      let normalizedY = ((localPos.y % wrapCycleY) + wrapCycleY) % wrapCycleY;
      localPos = { x: normalizedX, y: normalizedY };
    }
    
    // Calculate scale to show a reasonable viewport around the player
    // Show approximately 2x track size around the player for better visibility
    const viewportSize = Math.max(track.width, track.height) * 1.5;
    const scale = minimapSize / viewportSize;
    
    // Center offset - local player is always at center
    const centerOffsetX = minimapRadius;
    const centerOffsetY = minimapRadius;
    
    // Helper to convert world coords to minimap coords (centered on local player)
    const worldToMinimap = (worldX: number, worldY: number) => {
      const relX = worldX - localPos.x;
      const relY = worldY - localPos.y;
      return {
        x: centerOffsetX + relX * scale,
        y: centerOffsetY + relY * scale
      };
    };
    
    // For wrap-around tracks, draw tiled elements at track dimension spacing
    // The tiles should connect seamlessly at track.width boundaries (not wrap cycle)
    const tileOffsets = track.wrapAround 
      ? [
          { x: -track.width, y: -track.height },
          { x: 0, y: -track.height },
          { x: track.width, y: -track.height },
          { x: -track.width, y: 0 },
          { x: 0, y: 0 },
          { x: track.width, y: 0 },
          { x: -track.width, y: track.height },
          { x: 0, y: track.height },
          { x: track.width, y: track.height },
        ]
      : [{ x: 0, y: 0 }];
    
    // Draw track elements for each tile
    if (track.elements && track.elements.length > 0) {
      tileOffsets.forEach(offset => {
        track.elements!.forEach(element => {
          const worldX = (element.x ?? element.position?.x ?? 0) + offset.x;
          const worldY = (element.y ?? element.position?.y ?? 0) + offset.y;
          const pos = worldToMinimap(worldX, worldY);
          const width = (element.width || 100) * scale;
          const height = (element.height || 100) * scale;
          
          // Only draw if visible on minimap (with margin)
          if (pos.x + width < -50 || pos.x > minimapSize + 50 ||
              pos.y + height < -50 || pos.y > minimapSize + 50) {
            return;
          }
          
          switch (element.type) {
            case 'road':
              ctx.fillStyle = '#666699';
              ctx.fillRect(pos.x, pos.y, width, height);
              break;
            case 'wall':
              ctx.fillStyle = '#ff4444';
              ctx.fillRect(pos.x, pos.y, width, height);
              break;
            case 'finish':
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(pos.x, pos.y, width, height);
              break;
          }
        });
      });
    }

    // Draw cars
    players.forEach(player => {
      const car = cars.get(player.id);
      if (!car) return;
      
      const isLocal = player.id === localPlayerId;
      const color = CAR_COLORS[player.color as CarColor]?.hex || '#888';
      
      // Calculate position relative to local player
      let relX: number;
      let relY: number;
      
      if (isLocal) {
        // Local player is always at center of minimap
        relX = 0;
        relY = 0;
      } else {
        // For remote players, calculate relative position
        relX = car.displayPosition.x - localPos.x;
        relY = car.displayPosition.y - localPos.y;
        
        // For wrap-around tracks, find the closest position
        if (track.wrapAround) {
          const wrapCycleX = track.width;
          const wrapCycleY = track.height;
          if (relX > wrapCycleX / 2) relX -= wrapCycleX;
          else if (relX < -wrapCycleX / 2) relX += wrapCycleX;
          if (relY > wrapCycleY / 2) relY -= wrapCycleY;
          else if (relY < -wrapCycleY / 2) relY += wrapCycleY;
        }
      }
      
      const screenX = centerOffsetX + relX * scale;
      const screenY = centerOffsetY + relY * scale;
      
      // Check if car is within visible minimap area
      const margin = 10;
      const isOnScreen = screenX >= margin && screenX <= minimapSize - margin &&
                         screenY >= margin && screenY <= minimapSize - margin;
      
      if (isOnScreen || isLocal) {
        // Draw car normally
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(
          Math.max(margin, Math.min(minimapSize - margin, screenX)),
          Math.max(margin, Math.min(minimapSize - margin, screenY)),
          isLocal ? 5 : 3, 
          0, Math.PI * 2
        );
        ctx.fill();
        
        if (isLocal) {
          ctx.strokeStyle = '#00d9ff';
          ctx.lineWidth = 2;
          ctx.stroke();
          
          // Draw direction indicator for local player
          const dirLength = 10;
          const rotation = car.displayRotation || 0;
          ctx.beginPath();
          ctx.moveTo(screenX, screenY);
          ctx.lineTo(
            screenX + Math.sin(rotation) * dirLength,
            screenY - Math.cos(rotation) * dirLength
          );
          ctx.strokeStyle = '#00d9ff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      } else {
        // Draw off-screen indicator at edge of minimap
        const angle = Math.atan2(relY, relX);
        const edgeRadius = minimapRadius - 8;
        
        // Calculate edge position
        const edgeX = centerOffsetX + Math.cos(angle) * edgeRadius;
        const edgeY = centerOffsetY + Math.sin(angle) * edgeRadius;
        
        // Draw arrow pointing toward the other player
        ctx.save();
        ctx.translate(edgeX, edgeY);
        ctx.rotate(angle);
        
        // Draw a small triangle/arrow
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(6, 0);        // Point
        ctx.lineTo(-4, -4);      // Top left
        ctx.lineTo(-4, 4);       // Bottom left
        ctx.closePath();
        ctx.fill();
        
        // Add border for visibility
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        ctx.restore();
        
        // Optional: draw distance indicator
        const distance = Math.sqrt(relX * relX + relY * relY);
        if (distance > 100) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'center';
          const textX = centerOffsetX + Math.cos(angle) * (edgeRadius - 14);
          const textY = centerOffsetY + Math.sin(angle) * (edgeRadius - 14) + 3;
          ctx.fillText(Math.round(distance) + 'm', textX, textY);
        }
      }
    });
    
    // Draw center crosshair for local player
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerOffsetX - 8, centerOffsetY);
    ctx.lineTo(centerOffsetX + 8, centerOffsetY);
    ctx.moveTo(centerOffsetX, centerOffsetY - 8);
    ctx.lineTo(centerOffsetX, centerOffsetY + 8);
    ctx.stroke();
    
  }, [track, cars, players, localPlayerId]);
  
  return <canvas ref={canvasRef} width={150} height={150} />;
}

export default GameHUD;
