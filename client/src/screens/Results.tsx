import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useNetworkStore } from '../store/networkStore';
import { useSettingsStore } from '../store/settingsStore';
import { CAR_COLORS, CarColor } from '@shared';
import './Results.css';

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(2, '0')}`;
}

function Results() {
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId } = useParams();
  const { room, localPlayerId, leaveRoom } = useNetworkStore();
  const { nickname } = useSettingsStore();
  const [showFullResults, setShowFullResults] = useState(false);

  // Redirect if no room
  useEffect(() => {
    if (!room) {
      if (location.pathname !== '/lobby') {
        navigate('/lobby');
      }
    }
  }, [room, navigate, location.pathname]);

  if (!room) {
    return null;
  }

  const localPlayer = room.players.find(p => p.id === localPlayerId);
  const sortedPlayers = [...room.players].sort((a, b) => {
    // Sort by position (finished players first, then by distance traveled)
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) {
      return (a.finishTime || 0) - (b.finishTime || 0);
    }
    return (b.lap - a.lap) || (b.checkpointIndex - a.checkpointIndex);
  });

  const localPlayerPosition = sortedPlayers.findIndex(p => p.id === localPlayerId) + 1;
  const winner = sortedPlayers[0];

  const handlePlayAgain = () => {
    const target = `/room/${room.id}`;
    if (location.pathname !== target) {
      navigate(target);
    }
  };

  const handleLeave = () => {
    leaveRoom();
    if (location.pathname !== '/lobby') {
      navigate('/lobby');
    }
  };

  return (
    <div className="screen results">
      <div className="results-content animate-slide-up">
        {/* Winner Celebration */}
        <div className="winner-section">
          <div className="trophy">🏆</div>
          <h1>{winner?.nickname || 'Unknown'} Wins!</h1>
          {winner?.finishTime && (
            <p className="winner-time">{formatTime(winner.finishTime)}</p>
          )}
        </div>

        {/* Local Player Result */}
        {localPlayer && localPlayer.id !== winner?.id && (
          <div className="local-result card">
            <span className="position">#{localPlayerPosition}</span>
            <div className="local-details">
              <span className="your-name">{localPlayer.nickname}</span>
              {localPlayer.finished && localPlayer.finishTime && (
                <span className="your-time">{formatTime(localPlayer.finishTime)}</span>
              )}
              {!localPlayer.finished && (
                <span className="dnf">Did Not Finish</span>
              )}
            </div>
          </div>
        )}

        {/* Full Leaderboard */}
        <div className="leaderboard card">
          <div className="leaderboard-header" onClick={() => setShowFullResults(!showFullResults)}>
            <h2>Race Results</h2>
            <span className="toggle">{showFullResults ? '▲' : '▼'}</span>
          </div>
          
          {showFullResults && (
            <div className="leaderboard-list">
              {sortedPlayers.map((player, index) => (
                <div 
                  key={player.id} 
                  className={`leaderboard-row ${player.id === localPlayerId ? 'local' : ''}`}
                >
                  <span className="rank">
                    {index === 0 && '🥇'}
                    {index === 1 && '🥈'}
                    {index === 2 && '🥉'}
                    {index > 2 && `#${index + 1}`}
                  </span>
                  <div 
                    className="row-car"
                    style={{ backgroundColor: CAR_COLORS[player.color as CarColor]?.hex || '#888' }}
                  />
                  <span className="row-name">{player.nickname}</span>
                  <span className="row-time">
                    {player.finished && player.finishTime
                      ? formatTime(player.finishTime)
                      : 'DNF'
                    }
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stats */}
        {localPlayer && (
          <div className="stats-grid">
            <div className="stat-card card">
              <span className="stat-value">{localPlayer.lap}</span>
              <span className="stat-label">Laps Completed</span>
            </div>
            <div className="stat-card card">
              <span className="stat-value">{localPlayer.bestLapTime ? formatTime(localPlayer.bestLapTime) : '--'}</span>
              <span className="stat-label">Best Lap</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="results-actions">
          <button className="btn btn-primary btn-large" onClick={handlePlayAgain}>
            🔄 Play Again
          </button>
          <button className="btn btn-secondary btn-large" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

export default Results;
