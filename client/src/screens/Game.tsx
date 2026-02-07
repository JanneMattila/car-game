import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useNetworkStore } from '../store/networkStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import GameRenderer from '../game/GameRenderer';
import GameHUD from '../components/GameHUD';
import GameOverlay from '../components/GameOverlay';
import Countdown from '../components/Countdown';
import DebugOverlay from '../components/DebugOverlay';

function Game() {
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId } = useParams();
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { room, localPlayerId } = useNetworkStore();
  const { countdown, raceTimer, respawning } = useGameStore();
  const { showMinimap, soundEnabled, musicEnabled } = useSettingsStore();
  
  const [isPaused, setIsPaused] = useState(false);

  // Navigate to results when race ends
  useEffect(() => {
    if (room?.state === 'results') {
      const target = `/results/${room.id}`;
      if (location.pathname !== target) {
        navigate(target);
      }
    }
  }, [room?.state, room?.id, navigate, location.pathname]);

  // Redirect if no room
  useEffect(() => {
    if (!room) {
      if (location.pathname !== '/lobby') {
        navigate('/lobby');
      }
    }
  }, [room, navigate, location.pathname]);

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

  if (!room) {
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
                  // Note: Browser back navigation doesn't work reliably in games
                  // due to fullscreen mode and complex routing. Use direct navigation instead.
                  navigate(`/room/${roomId}`);
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
                  navigate('/lobby');
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
