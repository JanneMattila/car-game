import { RoomInfo, CAR_COLORS, CarColor } from '@shared';
import { useGameStore } from '../store/gameStore';
import './GameHUD.css';

interface GameHUDProps {
  room: RoomInfo;
  localPlayerId: string | null;
  raceTimer: number;
  showMinimap: boolean;
}

function GameHUD({ room, localPlayerId, raceTimer, showMinimap }: GameHUDProps) {
  const { cars } = useGameStore();
  
  const localPlayer = room.players.find((p) => p.id === localPlayerId);
  const localCar = localPlayerId ? cars.get(localPlayerId) : null;

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
      </div>

      {/* Minimap */}
      {showMinimap && (
        <div className="hud-minimap">
          <div className="minimap-container">
            <canvas id="minimap-canvas" width="150" height="150" />
            {/* Car dots */}
            {sortedPlayers.map(player => {
              const car = cars.get(player.id);
              if (!car) return null;
              
              // Scale car position to minimap
              const scale = 150 / 2000; // Assuming 2000px track
              const x = car.displayPosition.x * scale;
              const y = car.displayPosition.y * scale;
              
              return (
                <div
                  key={player.id}
                  className={`minimap-dot ${player.id === localPlayerId ? 'local' : ''}`}
                  style={{
                    backgroundColor: CAR_COLORS[player.color as CarColor]?.hex || '#888',
                    left: `${x}px`,
                    top: `${y}px`,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default GameHUD;
