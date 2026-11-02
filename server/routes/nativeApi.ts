import { Router, type Request, type Response } from 'express';
import {
  ProfileError,
  ProfileManager,
  publicProfile,
  type Profile,
} from '../profiles/profileManager.js';
import { NativeLobbyError, NativeMatchManager } from '../native/nativeMatchManager.js';

type Handler = (req: Request, res: Response) => Promise<void> | void;

function idParam(req: Request): string {
  const value = req.params['id'];
  return typeof value === 'string' ? value : '';
}

function handle(fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof NativeLobbyError) {
        res.status(err.status).json({ error: err.message });
      } else if (err instanceof ProfileError) {
        res.status(400).json({ error: err.message });
      } else {
        console.error('Native API error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
}

/** Profile API (shared by all clients) and lobby API for the native game client. */
export function createNativeApiRoutes(
  profiles: ProfileManager,
  matches: NativeMatchManager
): Router {
  const router = Router();

  const requireProfile = async (value: unknown): Promise<Profile> => {
    if (typeof value !== 'string' || !value) throw new NativeLobbyError('profileId is required');
    const profile = await profiles.get(value);
    if (!profile) throw new NativeLobbyError('Profile not found', 404);
    return profile;
  };

  router.post(
    '/profiles',
    handle(async (req, res) => {
      const profile = await profiles.create(req.body ?? {});
      res.status(201).json(publicProfile(profile));
    })
  );

  router.get(
    '/profiles/:id',
    handle(async (req, res) => {
      const profile = await profiles.get(idParam(req));
      if (!profile) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }
      res.json(publicProfile(profile));
    })
  );

  router.put(
    '/profiles/:id',
    handle(async (req, res) => {
      const profile = await profiles.update(idParam(req), req.body ?? {});
      if (!profile) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }
      res.json(publicProfile(profile));
    })
  );

  router.get(
    '/native/lobbies',
    handle((_req, res) => {
      res.json(matches.list());
    })
  );

  router.post(
    '/native/lobbies',
    handle(async (req, res) => {
      const profile = await requireProfile(req.body?.profileId);
      res.status(201).json(matches.create(profile, req.body ?? {}));
    })
  );

  router.get(
    '/native/debug',
    handle((_req, res) => {
      res.json(matches.debug());
    })
  );

  router.get(
    '/native/lobbies/:id',
    handle((req, res) => {
      const profileId =
        typeof req.query['profileId'] === 'string' ? req.query['profileId'] : undefined;
      res.json(matches.get(idParam(req), profileId));
    })
  );

  router.post(
    '/native/lobbies/:id/join',
    handle(async (req, res) => {
      const profile = await requireProfile(req.body?.profileId);
      res.json(matches.join(idParam(req), profile));
    })
  );

  router.post(
    '/native/lobbies/:id/leave',
    handle(async (req, res) => {
      const profile = await requireProfile(req.body?.profileId);
      matches.leave(idParam(req), profile.id);
      res.json({ ok: true });
    })
  );

  router.post(
    '/native/lobbies/:id/ready',
    handle(async (req, res) => {
      const profile = await requireProfile(req.body?.profileId);
      res.json(matches.setReady(idParam(req), profile.id, req.body?.ready !== false));
    })
  );

  router.post(
    '/native/lobbies/:id/settings',
    handle(async (req, res) => {
      const profile = await requireProfile(req.body?.profileId);
      res.json(matches.updateSettings(idParam(req), profile.id, req.body ?? {}));
    })
  );

  router.post(
    '/native/lobbies/:id/start',
    handle(async (req, res) => {
      const profile = await requireProfile(req.body?.profileId);
      res.json(matches.start(idParam(req), profile.id));
    })
  );

  return router;
}
