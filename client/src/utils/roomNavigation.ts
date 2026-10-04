import { matchPath } from 'react-router-dom';
import type { RoomInfo } from '@shared';

export interface RoomNavigationState {
  pathname: string;
  locationKey: string;
  room: Pick<RoomInfo, 'id' | 'state'> | null;
}

export type RoomNavigationAction =
  | { type: 'none' }
  | { type: 'leave' }
  | { type: 'navigate'; pathname: string; replace: boolean };

export function roomRoute(pathname: string) {
  for (const [pattern, screen] of [
    ['/room/:roomId', 'room'],
    ['/room/:roomId/game', 'game'],
    ['/game/:roomId', 'game'],
    ['/results/:roomId', 'results'],
  ] as const) {
    const match = matchPath(pattern, pathname);
    if (match?.params.roomId) return { roomId: match.params.roomId, screen };
  }
  return null;
}

function isActive(state: RoomInfo['state']): boolean {
  return state === 'countdown' || state === 'racing';
}

export function roomNavigationAction(
  previous: RoomNavigationState | null,
  current: RoomNavigationState,
  pendingLocationKey?: string
): RoomNavigationAction {
  const { pathname, room } = current;
  // Phase packets can arrive before the router commits a room navigation.
  if (room && pendingLocationKey === current.locationKey) return { type: 'none' };
  // StrictMode and unrelated store updates must not repeat a pending navigation.
  if (
    previous?.locationKey === current.locationKey &&
    previous.pathname === pathname &&
    previous.room?.id === room?.id &&
    previous.room?.state === room?.state
  ) {
    return { type: 'none' };
  }

  const route = roomRoute(pathname);
  if (!room) {
    return route ? { type: 'navigate', pathname: '/lobby', replace: true } : { type: 'none' };
  }

  if (previous?.room?.id !== room.id) {
    const target = isActive(room.state) ? `/room/${room.id}/game` : `/room/${room.id}`;
    return pathname === target
      ? { type: 'none' }
      : { type: 'navigate', pathname: target, replace: false };
  }

  if (route?.roomId !== room.id) return { type: 'leave' };

  if (isActive(room.state) && !isActive(previous.room.state)) {
    return route.screen === 'game'
      ? { type: 'none' }
      : { type: 'navigate', pathname: `/room/${room.id}/game`, replace: true };
  }
  if (room.state === 'results' && previous.room.state !== 'results' && route.screen === 'game') {
    return { type: 'navigate', pathname: `/results/${room.id}`, replace: true };
  }

  return { type: 'none' };
}
