import { Routes, Route } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useNetworkStore } from './store/networkStore';
import { useSettingsStore } from './store/settingsStore';
import { useKeyboardInput } from './game/InputHandler';
import { TouchControls } from './components';

import MainMenu from './screens/MainMenu';
import Lobby from './screens/Lobby';
import WaitingRoom from './screens/WaitingRoom';
import Game from './screens/Game';
import Results from './screens/Results';
import TrackEditor from './screens/TrackEditor';

function App() {
  const connectRef = useRef(useNetworkStore.getState().connect);
  const loadSettingsRef = useRef(useSettingsStore.getState().loadFromStorage);
  const room = useNetworkStore(state => state.room);

  useEffect(() => {
    // Load settings from local storage
    loadSettingsRef.current();
    
    // Connect to server only once
    connectRef.current();
  }, []);

  // Initialize keyboard input
  useKeyboardInput();

  const showTouchControls = room && (room.state === 'racing' || room.state === 'countdown');

  return (
    <div className="app">
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
