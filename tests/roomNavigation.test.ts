import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  roomNavigationAction,
  roomRoute,
  type RoomNavigationState,
} from '../client/src/utils/roomNavigation';
import type { RoomState } from '../shared/types/room';

function location(
  pathname: string,
  state: RoomState | null,
  locationKey = pathname,
  id = 'room-1'
): RoomNavigationState {
  return { pathname, locationKey, room: state === null ? null : { id, state } };
}

test('joining creates one room history entry from home or lobby', () => {
  for (const source of ['/', '/lobby']) {
    assert.deepEqual(roomNavigationAction(location(source, null), location(source, 'waiting')), {
      type: 'navigate',
      pathname: '/room/room-1',
      replace: false,
    });
    assert.deepEqual(roomNavigationAction(location(source, null), location(source, 'racing')), {
      type: 'navigate',
      pathname: '/room/room-1/game',
      replace: false,
    });
    assert.deepEqual(roomNavigationAction(location(source, null), location(source, 'results')), {
      type: 'navigate',
      pathname: '/room/room-1',
      replace: false,
    });
  }
});

test('automatic countdown, results and rematch transitions replace the room entry', () => {
  for (const [from, to, previousState, currentState] of [
    ['/room/room-1', '/room/room-1/game', 'waiting', 'countdown'],
    ['/room/room-1/game', '/results/room-1', 'racing', 'results'],
    ['/results/room-1', '/room/room-1/game', 'results', 'countdown'],
  ] as const) {
    assert.deepEqual(
      roomNavigationAction(location(from, previousState), location(from, currentState)),
      { type: 'navigate', pathname: to, replace: true }
    );
  }
});

test('Back out of a room leaves it instead of redirecting into the race again', () => {
  for (const state of ['waiting', 'countdown', 'racing', 'results'] as const) {
    for (const destination of ['/', '/lobby', '/editor', '/editor/suzuka-grand-prix']) {
      assert.deepEqual(
        roomNavigationAction(location('/room/room-1/game', state), location(destination, state)),
        { type: 'leave' }
      );
      assert.deepEqual(
        roomNavigationAction(location(destination, state), location(destination, null)),
        { type: 'none' }
      );
    }
  }
});

test('Forward into an expired room route replaces it with the lobby', () => {
  for (const pathname of ['/room/room-1', '/room/room-1/game', '/game/room-1', '/results/room-1']) {
    assert.deepEqual(roomNavigationAction(location('/lobby', null), location(pathname, null)), {
      type: 'navigate',
      pathname: '/lobby',
      replace: true,
    });
  }
});

test('visiting the room during a race is allowed and the countdown does not bounce it back', () => {
  assert.deepEqual(
    roomNavigationAction(
      location('/room/room-1/game', 'racing'),
      location('/room/room-1', 'racing')
    ),
    { type: 'none' }
  );
  assert.deepEqual(
    roomNavigationAction(location('/room/room-1', 'countdown'), location('/room/room-1', 'racing')),
    { type: 'none' }
  );
});

test('StrictMode and player updates cannot duplicate a join or turn it into a leave', () => {
  const joined = location('/lobby', 'waiting', 'lobby-key');
  assert.deepEqual(
    roomNavigationAction(joined, {
      ...joined,
      room: { id: 'room-1', state: 'waiting' },
    }),
    {
      type: 'none',
    }
  );
  const game = location('/room/room-1/game', 'racing', 'game-key');
  assert.deepEqual(
    roomNavigationAction(game, {
      ...game,
      room: { id: 'room-1', state: 'racing' },
    }),
    {
      type: 'none',
    }
  );
});

test('route ownership recognizes aliases and trailing slashes, not unrelated or other rooms', () => {
  assert.deepEqual(roomRoute('/room/room-1/'), { roomId: 'room-1', screen: 'room' });
  assert.deepEqual(roomRoute('/game/room-1'), { roomId: 'room-1', screen: 'game' });
  assert.equal(roomRoute('/editor/room-1'), null);
  assert.equal(roomRoute('/room/room-1/game/extra'), null);
  assert.deepEqual(
    roomNavigationAction(
      location('/room/room-1/game', 'racing'),
      location('/room/room-2', 'racing')
    ),
    { type: 'leave' }
  );
});

test('phase packets during a pending join cannot mistake the source screen for leaving', () => {
  const joined = location('/lobby', 'waiting', 'source-key');
  const countdown = location('/lobby', 'countdown', 'source-key');
  assert.deepEqual(roomNavigationAction(joined, countdown, 'source-key'), { type: 'none' });
  assert.deepEqual(
    roomNavigationAction(joined, location('/room/room-1', 'countdown', 'room-key'), 'source-key'),
    { type: 'navigate', pathname: '/room/room-1/game', replace: true }
  );
  assert.deepEqual(
    roomNavigationAction(
      location('/', 'racing', 'source-key'),
      location('/', 'countdown', 'source-key'),
      'source-key'
    ),
    { type: 'none' }
  );
});

test('the home-lobby-room-race-results history has no automatic intermediate entries', () => {
  const history = ['/', '/lobby'];
  let previous = location('/lobby', null, 'lobby');
  let current = location('/lobby', 'waiting', 'lobby');
  for (const state of ['waiting', 'countdown', 'racing', 'results'] as const) {
    current = { ...current, room: { id: 'room-1', state } };
    const action = roomNavigationAction(previous, current);
    previous = current;
    if (action.type === 'navigate') {
      if (action.replace) history[history.length - 1] = action.pathname;
      else history.push(action.pathname);
      current = location(action.pathname, state, `${state}-key`);
      assert.equal(roomNavigationAction(previous, current).type, 'none');
      previous = current;
    }
  }
  assert.deepEqual(history, ['/', '/lobby', '/results/room-1']);
  assert.equal(
    roomNavigationAction(previous, location('/lobby', 'results', 'lobby')).type,
    'leave'
  );
});
