import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useNetworkStore } from '../store/networkStore';
import { useSettingsStore } from '../store/settingsStore';
import { CAR_COLORS } from '@shared';
import './Lobby.css';

function Lobby() {
  const navigate = useNavigate();
  const location = useLocation();
  const { 
    connected, 
    room, 
    roomList, 
    trackList,
    requestRoomList, 
    requestTrackList,
    joinRoom,
    createRoom,
  } = useNetworkStore();
  const { nickname, preferredColor } = useSettingsStore();

  useEffect(() => {
    if (connected) {
      requestRoomList();
      requestTrackList();
    }
  }, [connected, requestRoomList, requestTrackList]);

  // Navigate to room when joined
  useEffect(() => {
    if (room) {
      const target = `/room/${room.id}`;
      if (location.pathname !== target) {
        navigate(target);
      }
    }
  }, [room, navigate, location.pathname]);

  // Refresh room list periodically
  useEffect(() => {
    const interval = setInterval(() => {
      if (connected) {
        requestRoomList();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [connected, requestRoomList]);

  const handleJoinRoom = (roomId: string) => {
    joinRoom(roomId, nickname, preferredColor);
  };

  const handleCreateRoom = (trackId: string, isPrivate: boolean) => {
    createRoom({ trackId, isPrivate }, nickname, preferredColor);
  };

  const getTrackName = (trackId: string) => {
    return trackList.find(t => t.id === trackId)?.name || 'Unknown Track';
  };

  return (
    <div className="screen lobby">
      <header className="header">
        <button className="btn btn-ghost" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h1>Game Lobby</h1>
        <button 
          className="btn btn-primary"
          onClick={() => handleCreateRoom('default-oval', false)}
        >
          + Create Room
        </button>
      </header>

      <div className="screen-content">
        <section className="room-list-section">
          <h2>Available Rooms ({roomList.length})</h2>
          
          {roomList.length === 0 ? (
            <div className="empty-state">
              <p>No public rooms available</p>
              <p className="text-muted">Create a room to start playing!</p>
            </div>
          ) : (
            <div className="room-list">
              {roomList.map((roomItem) => (
                <div key={roomItem.id} className="room-card card">
                  <div className="room-info">
                    <h3>{roomItem.hostNickname}'s Room</h3>
                    <p className="track-name">{roomItem.trackName}</p>
                    <div className="room-details">
                      <span className="detail">
                        👥 {roomItem.playerCount}/{roomItem.maxPlayers}
                      </span>
                      <span className="detail">
                        🏁 {roomItem.lapCount} laps
                      </span>
                      <span className={`status-badge ${roomItem.state}`}>
                        {roomItem.state === 'waiting' ? 'Waiting' : 
                         roomItem.state === 'racing' ? 'Racing' : 'Results'}
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleJoinRoom(roomItem.id)}
                    disabled={roomItem.playerCount >= roomItem.maxPlayers}
                  >
                    {roomItem.playerCount >= roomItem.maxPlayers ? 'Full' : 'Join'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="tracks-section">
          <h2>Available Tracks</h2>
          <div className="track-list">
            {trackList.map((track) => (
              <div key={track.id} className="track-card card">
                <div className="track-preview">
                  <div className="track-placeholder">🏎️</div>
                </div>
                <div className="track-info">
                  <h3>{track.name}</h3>
                  <p className="text-muted">by {track.author}</p>
                  <span className={`difficulty-badge ${track.difficulty}`}>
                    {track.difficulty}
                  </span>
                </div>
                <div className="track-actions">
                  <button
                    className="btn btn-primary btn-small"
                    onClick={() => handleCreateRoom(track.id, false)}
                  >
                    Public
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => handleCreateRoom(track.id, true)}
                  >
                    Private
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Lobby;
