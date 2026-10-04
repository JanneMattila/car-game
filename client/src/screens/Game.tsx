import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useNetworkStore } from '../store/networkStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import GameRenderer from '../game/GameRenderer';
import { useKeyboardInput } from '../game/InputHandler';
import GameHUD from '../components/GameHUD';
import GameOverlay from '../components/GameOverlay';
import Countdown from '../components/Countdown';
import DebugOverlay from '../components/DebugOverlay';

function Game() {
  const navigate = useNavigate();
  const { roomId } = useParams();
  const containerRef = useRef<HTMLDivElement>(null);
  
  const room = useNetworkStore(state => state.room);
  const localPlayerId = useNetworkStore(state => state.localPlayerId);
  const countdown = useGameStore(state => state.countdown);
  const raceTimer = useGameStore(state => state.raceTimer);
  const respawning = useGameStore(state => state.respawning);
  const showMinimap = useSettingsStore(state => state.showMinimap);
  
  const [isPaused, setIsPaused] = useState(false);

  useKeyboardInput();

  // Handle escape key for pause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPaused(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!room || room.id !== roomId) {
    return null;
  }

  const localPlayer = room.players.find(p => p.id === localPlayerId);

  return (
    <div className="screen game-screen">
      <div className="game-container" ref={containerRef}>
        <GameRenderer 
          containerRef={containerRef}
          room={room}
          localPlayerId={localPlayerId}
        />
      </div>

      {/* HUD Overlay */}
      <GameHUD 
        room={room}
        localPlayerId={localPlayerId}
        raceTimer={raceTimer}
        showMinimap={showMinimap}
      />

      {/* Countdown Overlay */}
      {room.state === 'countdown' && countdown !== null && (
        <Countdown value={countdown} />
      )}

      {/* Respawning Overlay */}
      {respawning && (
        <GameOverlay 
          text="Respawning"
          color="#f59e0b"
        />
      )}

      {/* Debug Overlay */}
      <DebugOverlay localPlayerId={localPlayerId} />

      {/* Pause Menu */}
      {isPaused && (
        <div className="pause-overlay">
          <div className="pause-menu card">
            <h2>Paused</h2>
            <div className="pause-options">
              <button 
                className="btn btn-primary" 
                onClick={() => setIsPaused(false)}
              >
                Resume
              </button>
              <button 
                className="btn btn-secondary"
                onClick={() => {
                  // Toggle settings
                }}
              >
                Settings
              </button>
              <button 
                className="btn btn-ghost"
                onClick={() => {
                  navigate(`/room/${roomId}`, { replace: true });
                }}
              >
                ← Back to Room
              </button>
              <button 
                className="btn btn-secondary"
                onClick={() => {
                  // Leave race and go to lobby
                  const { leaveRoom } = useNetworkStore.getState();
                  leaveRoom();
                  navigate('/lobby', { replace: true });
                }}
              >
                Leave Race
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Game;
