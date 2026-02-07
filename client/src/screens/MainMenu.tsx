import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSettingsStore } from '../store/settingsStore';
import { useNetworkStore } from '../store/networkStore';
import { CarColor, COLOR_ORDER, CAR_COLORS } from '@shared';
import './MainMenu.css';

function MainMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const { nickname, preferredColor, setNickname, setPreferredColor } = useSettingsStore();
  const { connected, createRoom, joinRoom, room, trackList, requestTrackList } = useNetworkStore();
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(!nickname);

  // Navigate as soon as a room is joined (quick play or manual join)
  useEffect(() => {
    if (room) {
      const target = `/room/${room.id}`;
      if (location.pathname !== target) {
        navigate(target);
      }
    }
  }, [room, navigate, location.pathname]);

  // Refresh tracks so quick play can pick from available options
  useEffect(() => {
    if (connected) {
      requestTrackList();
    }
  }, [connected, requestTrackList]);

  const handlePlay = () => {
    if (!nickname.trim()) {
      setError('Please enter a nickname');
      setShowSettings(true);
      return;
    }
    navigate('/lobby');
  };

  const handleQuickPlay = () => {
    if (!nickname.trim()) {
      setError('Please enter a nickname');
      setShowSettings(true);
      return;
    }
    if (!trackList.length) {
      setError('No tracks available for quick play.');
      alert('No tracks available for quick play. Please add a track first.');
      return;
    }
    const randomTrack = trackList[Math.floor(Math.random() * trackList.length)];
    if (!randomTrack) {
      console.error('No tracks available for quick play');
      return;
    }
    createRoom({ isPrivate: false, trackId: randomTrack.id }, nickname, preferredColor);
    // Navigation will happen when room_joined is received
  };

  const handleJoinByCode = () => {
    if (!nickname.trim()) {
      setError('Please enter a nickname');
      setShowSettings(true);
      return;
    }
    if (!joinCode.trim() || joinCode.length !== 6) {
      setError('Please enter a valid 6-character room code');
      return;
    }
    joinRoom(joinCode.toUpperCase(), nickname, preferredColor);
  };

  return (
    <div className="screen main-menu">
      <div className="menu-background">
        <div className="menu-content animate-slide-up">
          <h1 className="game-title">
            <span className="title-race">TURBO</span>
            <span className="title-io">CARS</span>
          </h1>
          
          <div className="connection-status">
            <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
            {connected ? 'Connected' : 'Connecting...'}
          </div>

          {showSettings && (
            <div className="settings-panel card">
              <h2>Player Settings</h2>
              
              <div className="form-group">
                <label>Nickname</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Enter nickname"
                  value={nickname}
                  onChange={(e) => {
                    setNickname(e.target.value);
                    setError('');
                  }}
                  maxLength={16}
                />
              </div>

              <div className="form-group">
                <label>Car Color</label>
                <div className="color-picker">
                  {COLOR_ORDER.map((color) => (
                    <button
                      key={color}
                      className={`color-option ${preferredColor === color ? 'selected' : ''}`}
                      style={{ backgroundColor: CAR_COLORS[color].hex }}
                      onClick={() => setPreferredColor(color)}
                      title={CAR_COLORS[color].name}
                    />
                  ))}
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <button
                className="btn btn-primary"
                onClick={() => {
                  if (nickname.trim()) {
                    setShowSettings(false);
                  } else {
                    setError('Please enter a nickname');
                  }
                }}
              >
                Save
              </button>
            </div>
          )}

          {!showSettings && (
            <div className="menu-buttons">
              <button
                className="btn btn-primary btn-large"
                onClick={handlePlay}
                disabled={!connected}
              >
                🎮 Play
              </button>

              <button
                className="btn btn-accent btn-large"
                onClick={handleQuickPlay}
                disabled={!connected}
              >
                ⚡ Quick Play
              </button>

              <div className="join-code-section">
                <input
                  type="text"
                  className="input code-input"
                  placeholder="Enter room code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={6}
                />
                <button
                  className="btn btn-secondary"
                  onClick={handleJoinByCode}
                  disabled={!connected || !joinCode.trim()}
                >
                  Join
                </button>
              </div>

              <button
                className="btn btn-ghost"
                onClick={() => setShowSettings(true)}
              >
                ⚙️ Settings
              </button>

              <button
                className="btn btn-ghost"
                onClick={() => navigate('/editor')}
              >
                🛠️ Track Editor
              </button>
            </div>
          )}

          <div className="player-preview">
            <div 
              className="preview-car"
              style={{ backgroundColor: CAR_COLORS[preferredColor].hex }}
            />
            <span className="preview-name">{nickname || 'Player'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MainMenu;
