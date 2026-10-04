import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useNetworkStore } from './store/networkStore';
import { useSettingsStore } from './store/settingsStore';
import { TouchControls } from './components';
import {
  roomNavigationAction,
  roomRoute,
  type RoomNavigationState,
} from './utils/roomNavigation';

import MainMenu from './screens/MainMenu';
import Lobby from './screens/Lobby';
import WaitingRoom from './screens/WaitingRoom';
import Game from './screens/Game';
import Results from './screens/Results';
import TrackEditor from './screens/TrackEditor';

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const previousNavigation = useRef<RoomNavigationState | null>(null);
  const pendingNavigationKey = useRef<string | undefined>();
  const connectRef = useRef(useNetworkStore.getState().connect);
  const loadSettingsRef = useRef(useSettingsStore.getState().loadFromStorage);
  const room = useNetworkStore(state => state.room);
  const error = useNetworkStore(state => state.error);
  const clearError = useNetworkStore(state => state.clearError);
  const roomId = room?.id;
  const roomState = room?.state;

  useEffect(() => {
    const current: RoomNavigationState = {
      pathname: location.pathname,
      locationKey: location.key,
      room: roomId && roomState ? { id: roomId, state: roomState } : null,
    };
    if (pendingNavigationKey.current !== location.key) pendingNavigationKey.current = undefined;
    const action = roomNavigationAction(
      previousNavigation.current,
      current,
      pendingNavigationKey.current
    );
    if (current.room && pendingNavigationKey.current === location.key) return;
    previousNavigation.current = current;
    if (action.type === 'leave') {
      pendingNavigationKey.current = undefined;
      useNetworkStore.getState().leaveRoom();
    } else if (action.type === 'navigate') {
      pendingNavigationKey.current = location.key;
      navigate(action.pathname, { replace: action.replace });
    }
  }, [location.key, location.pathname, roomId, roomState, navigate]);

  useEffect(() => {
    // Load settings from local storage
    loadSettingsRef.current();
    
    // Connect to server only once
    connectRef.current();
  }, []);

  const route = roomRoute(location.pathname);
  const showTouchControls = route?.screen === 'game' && route.roomId === roomId &&
    (roomState === 'racing' || roomState === 'countdown');

  return (
    <div className="app">
      {error && (
        <div className="network-error" role="alert">
          <span>{error}</span>
          <button className="btn btn-ghost btn-small" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
      <Routes>
        <Route path="/" element={<MainMenu />} />
        <Route path="/lobby" element={<Lobby />} />
        <Route path="/room/:roomId" element={<WaitingRoom />} />
        <Route path="/room/:roomId/game" element={<Game />} />
        <Route path="/game/:roomId" element={<Game />} />
        <Route path="/results/:roomId" element={<Results />} />
        <Route path="/editor" element={<TrackEditor />} />
        <Route path="/editor/:trackId" element={<TrackEditor />} />
      </Routes>
      {showTouchControls && <TouchControls />}
    </div>
  );
}

export default App;
