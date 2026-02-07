import { Router, Request, Response } from 'express';
import { TrackManager } from '../tracks/trackManager.js';
import { LeaderboardManager } from '../leaderboards/leaderboardManager.js';
import { RoomManager } from '../game/roomManager.js';
import { Track } from '@shared';
import { logger } from '../utils/logger.js';

export function createApiRoutes(
  trackManager: TrackManager,
  leaderboardManager: LeaderboardManager,
  roomManager: RoomManager
): Router {
  const router = Router();

  // Track endpoints
  router.get('/tracks', (_req: Request, res: Response) => {
    const tracks = trackManager.getTrackList();
    res.json(tracks);
  });

  router.get('/tracks/:id', (req: Request, res: Response) => {
    const track = trackManager.getTrack(req.params['id'] as string);
    if (!track) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    res.json(track);
  });

  router.post('/tracks', async (req: Request, res: Response) => {
    try {
      const track = req.body as Track;
      const result = await trackManager.saveTrack(track);
      
      if (!result.isValid) {
        res.status(400).json({ error: 'Invalid track', errors: result.errors });
        return;
      }
      
      res.json({ success: true, track });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save track' });
    }
  });

  router.delete('/tracks/:id', async (req: Request, res: Response) => {
    const success = await trackManager.deleteTrack(req.params['id'] as string);
    if (!success) {
      res.status(404).json({ error: 'Track not found or cannot be deleted' });
      return;
    }
    res.json({ success: true });
  });

  // Leaderboard endpoints
  router.get('/leaderboards/:trackId', async (req: Request, res: Response) => {
    const leaderboard = await leaderboardManager.getLeaderboard(req.params['trackId'] as string);
    res.json(leaderboard);
  });

  // Room endpoints
  router.get('/rooms', (_req: Request, res: Response) => {
    const rooms = roomManager.getPublicRooms();
    res.json(rooms);
  });

  // Debug logging endpoints
  router.get('/debug/status', (_req: Request, res: Response) => {
    res.json({ enabled: logger.isEnabled() });
  });

  router.post('/debug/log', (req: Request, res: Response) => {
    if (!logger.isEnabled()) {
      res.json({ logged: false, reason: 'disabled' });
      return;
    }
    
    const { clientId, category, message, data } = req.body;
    logger.logFromClient(clientId || 'unknown', category || 'CLIENT', message || '', data);
    res.json({ logged: true });
  });

  router.post('/debug/log/batch', (req: Request, res: Response) => {
    if (!logger.isEnabled()) {
      res.json({ logged: false, reason: 'disabled' });
      return;
    }
    
    const { clientId, logs } = req.body;
    if (Array.isArray(logs)) {
      for (const log of logs) {
        logger.logFromClient(clientId || 'unknown', log.category || 'CLIENT', log.message || '', log.data);
      }
    }
    res.json({ logged: true, count: Array.isArray(logs) ? logs.length : 0 });
  });

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  return router;
}
