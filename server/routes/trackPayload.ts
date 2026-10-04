import express, { ErrorRequestHandler } from 'express';

export const MAX_TRACK_JSON_BYTES = 2 * 1024 * 1024;

export const trackJsonParser = () => express.json({ limit: MAX_TRACK_JSON_BYTES });

export const trackPayloadErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({
      error: 'Track upload exceeds the 2 MiB limit.',
      errors: [{ code: 'TRACK_TOO_LARGE', message: 'Track upload exceeds the 2 MiB limit.' }],
    });
    return;
  }
  next(error);
};
