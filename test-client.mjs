/**
 * Headless test client to analyze wrap-around behavior.
 * Connects via Socket.IO, creates a room, and drives forward
 * while logging position data to detect glitches at tile boundaries.
 */
import { io } from 'socket.io-client';

const SERVER = 'http://localhost:3000';
const TRACK_ID = 'track-1769970584891'; // Forever track

const socket = io(SERVER, { transports: ['websocket'] });

let playerId = null;
let roomCode = null;
let racing = false;
let lastPos = null;
let frameCount = 0;
let inputSeq = 0;

// Track dimensions for wrap detection
const TRACK_W = 800;
const TRACK_H = 600;
const WRAP_MARGIN = 50;
const WRAP_CYCLE_X = TRACK_W + WRAP_MARGIN;
const WRAP_CYCLE_Y = TRACK_H + WRAP_MARGIN;

socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('message', (msg) => {
  switch (msg.type) {
    case 'welcome':
      playerId = msg.playerId;
      console.log('Player ID:', playerId);
      // Create a room with the forever track
      socket.emit('message', {
        type: 'create_room',
        settings: { trackId: TRACK_ID, maxPlayers: 2, lapCount: 5 },
        nickname: 'TestBot',
        preferredColor: 'blue',
      });
      break;

    case 'room_joined':
      roomCode = msg.room.code;
      console.log('Joined room:', roomCode, 'Track:', msg.room.trackName);
      // Set ready
      socket.emit('message', { type: 'set_ready', ready: true });
      // Start game after a small delay
      setTimeout(() => {
        console.log('Starting game...');
        socket.emit('message', { type: 'start_game' });
      }, 500);
      break;

    case 'game_starting':
      console.log('Game starting, countdown:', msg.countdown);
      console.log('Track wrapAround:', msg.track?.wrapAround);
      break;

    case 'countdown':
      console.log('Countdown:', msg.count);
      break;

    case 'game_started':
      console.log('Race started! Driving forward...');
      racing = true;
      // Send accelerate input at ~60Hz
      const inputLoop = setInterval(() => {
        if (!racing) { clearInterval(inputLoop); return; }
        inputSeq++;
        socket.emit('message', {
          type: 'input',
          input: {
            playerId,
            sequence: inputSeq,
            timestamp: Date.now(),
            accelerate: true,
            brake: false,
            steerLeft: false,
            steerRight: false,
            steerValue: 0,
            nitro: false,
            handbrake: false,
            respawn: false,
          },
        });
      }, 16); // ~60Hz
      break;

    case 'game_state': {
      if (!msg.state?.cars) break;
      const myCar = msg.state.cars.find(c => c.pId === playerId || c.playerId === playerId);
      if (!myCar) break;

      // CarStateSnapshot uses short keys: p=[x,y], r=rotation, v=[vx,vy]
      const pos = myCar.p ? { x: myCar.p[0], y: myCar.p[1] } : { x: myCar.position?.x, y: myCar.position?.y };
      const vel = myCar.v ? { x: myCar.v[0], y: myCar.v[1] } : { x: 0, y: 0 };
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);

      frameCount++;

      if (lastPos) {
        const dx = pos.x - lastPos.x;
        const dy = pos.y - lastPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Detect wraps (position jumped by more than half wrap cycle)
        const wrapped = Math.abs(dx) > WRAP_CYCLE_X / 2 || Math.abs(dy) > WRAP_CYCLE_Y / 2;

        // Log every 10th frame for overview, or any wrap/large jump
        if (wrapped || dist > 100 || frameCount % 10 === 0) {
          console.log(
            `[${frameCount}]`,
            wrapped ? '*** WRAP ***' : '',
            `pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
            `delta=(${dx.toFixed(1)}, ${dy.toFixed(1)})`,
            `dist=${dist.toFixed(1)}`,
            `speed=${speed.toFixed(1)}`,
            `seq=${msg.state.sequence}`
          );
        }
      } else {
        console.log(`[${frameCount}] START pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) speed=${speed.toFixed(1)}`);
      }

      lastPos = { ...pos };

      // Stop after 500 frames (~25 seconds at 20Hz broadcast)
      if (frameCount > 500) {
        console.log('\nTest complete. Disconnecting.');
        racing = false;
        socket.disconnect();
        process.exit(0);
      }
      break;
    }

    case 'race_finished':
      console.log('Race finished!');
      racing = false;
      socket.disconnect();
      process.exit(0);
      break;

    case 'error':
      console.error('Server error:', msg.code, msg.message);
      break;
  }
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});

// Timeout safety
setTimeout(() => {
  console.log('Timeout - exiting');
  process.exit(1);
}, 60000);
