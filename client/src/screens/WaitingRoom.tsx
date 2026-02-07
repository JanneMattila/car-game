import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useNetworkStore } from '../store/networkStore';
import { useSettingsStore } from '../store/settingsStore';
import { CAR_COLORS, COLOR_ORDER, RoomState, CarColor } from '@shared';
import './WaitingRoom.css';

function WaitingRoom() {
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId } = useParams();
  const { 
    room, 
    localPlayerId,
    leaveRoom, 
    setReady, 
    startGame,
    trackList,
    requestTrackList,
  } = useNetworkStore();
  const { nickname } = useSettingsStore();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    requestTrackList();
  }, [requestTrackList]);

  // Navigate to game when racing starts
  useEffect(() => {
    if (room?.state === 'countdown' || room?.state === 'racing') {
      const target = `/room/${room.id}/game`;
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

  if (!room) {
    return null;
  }

  const localPlayer = room.players.find(p => p.id === localPlayerId);
  const isHost = localPlayer?.isHost;
  const track = trackList.find(t => t.id === room.trackId);
  const allReady = room.players.every(p => p.ready);
  const canStart = allReady && room.players.length >= 1;

  const handleLeave = () => {
    leaveRoom();
    navigate('/lobby');
  };

  const handleToggleReady = () => {
    if (localPlayer) {
      setReady(!localPlayer.ready);
    }
  };

  const handleStartGame = () => {
    startGame();
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(room.code || room.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyLink = () => {
    const inviteLink = `${window.location.origin}/?join=${room.code || room.id}`;
    navigator.clipboard.writeText(inviteLink);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleKickPlayer = (playerId: string) => {
    // TODO: Implement kick_player message type
    console.warn('Kick player not yet implemented', playerId);
  };

  return (
    <div className="screen waiting-room">
      <header className="header">
        <button className="btn btn-ghost" onClick={handleLeave}>
          ← Leave
        </button>
        <h1>{isHost ? 'Your Room' : `${room.players.find(p => p.isHost)?.nickname}'s Room`}</h1>
        <div className="room-code-section">
          <button 
            className="btn btn-secondary"
            onClick={() => setShowInviteModal(true)}
          >
            Invite
          </button>
        </div>
      </header>

      <div className="screen-content">
        <div className="waiting-layout">
          <section className="players-section card">
            <h2>Players ({room.players.length}/{room.maxPlayers})</h2>
            <div className="players-grid">
              {room.players.map((player, index) => (
                <div 
                  key={player.id} 
                  className={`player-slot ${player.ready ? 'ready' : ''} ${player.id === localPlayerId ? 'local' : ''}`}
                >
                  <div 
                    className="player-car"
                    style={{ backgroundColor: CAR_COLORS[player.color as CarColor]?.hex || '#888' }}
                  />
                  <div className="player-info">
                    <span className="player-name">
                      {player.nickname}
                      {player.isHost && <span className="host-badge">HOST</span>}
                    </span>
                    <span className={`ready-status ${player.ready ? 'ready' : ''}`}>
                      {player.ready ? '✓ Ready' : 'Not Ready'}
                    </span>
                  </div>
                  {isHost && player.id !== localPlayerId && (
                    <button 
                      className="btn btn-ghost btn-small kick-btn"
                      onClick={() => handleKickPlayer(player.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {/* Empty slots */}
              {Array.from({ length: room.maxPlayers - room.players.length }).map((_, i) => (
                <div key={`empty-${i}`} className="player-slot empty">
                  <div className="player-car empty" />
                  <div className="player-info">
                    <span className="player-name">Waiting...</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="room-info-section">
            <div className="card track-info">
              <h3>Track</h3>
              <div className="track-preview-large">
                <span className="track-emoji">🏎️</span>
              </div>
              <h4>{track?.name || 'Loading...'}</h4>
              {track && (
                <p className="text-muted">
                  {track.difficulty} • by {track.author}
                </p>
              )}
            </div>

            <div className="card settings-info">
              <h3>Settings</h3>
              <div className="setting-row">
                <span>Laps</span>
                <span>{room.lapCount}</span>
              </div>
              <div className="setting-row">
                <span>Visibility</span>
                <span>{room.isPrivate ? 'Private' : 'Public'}</span>
              </div>
              <div className="setting-row">
                <span>Collisions</span>
                <span>Enabled</span>
              </div>
            </div>
          </section>
        </div>

        <div className="action-bar">
          <button
            className={`btn btn-large ${localPlayer?.ready ? 'btn-secondary' : 'btn-accent'}`}
            onClick={handleToggleReady}
          >
            {localPlayer?.ready ? 'Not Ready' : 'Ready!'}
          </button>
          
          {isHost && (
            <button
              className="btn btn-primary btn-large"
              onClick={handleStartGame}
              disabled={!canStart}
            >
              {canStart ? '🏁 Start Race' : 'Waiting for players...'}
            </button>
          )}
        </div>
      </div>

      {/* Invite Modal */}
      {showInviteModal && (
        <div className="modal-overlay" onClick={() => setShowInviteModal(false)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h2>Invite Players</h2>
            <p className="text-muted">Share this code with friends:</p>
            
            <div className="room-code-display">
              <span className="code">{room.code || room.id.slice(0, 6).toUpperCase()}</span>
              <button className="btn btn-secondary" onClick={handleCopyCode}>
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>

            <p className="text-muted">Or share this link:</p>
            <div className="share-link">
              <input 
                type="text" 
                className="input" 
                readOnly 
                value={`${window.location.origin}/?join=${room.code || room.id}`}
              />
              <button className="btn btn-secondary" onClick={handleCopyLink}>
                {copiedLink ? '✓ Copied!' : 'Copy Link'}
              </button>
            </div>

            <button 
              className="btn btn-ghost"
              onClick={() => setShowInviteModal(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default WaitingRoom;
