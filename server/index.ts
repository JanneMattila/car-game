import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { SocketHandler } from './network/socketHandler.js';
import { RoomManager } from './game/roomManager.js';
import { TrackManager } from './tracks/trackManager.js';
import { LeaderboardManager } from './leaderboards/leaderboardManager.js';
import { StorageService } from './storage/storageService.js';
import { createApiRoutes } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const CLIENT_URL = process.env['CLIENT_URL'] || 'http://localhost:5173';
const DATA_DIR = process.env['DATA_DIR'] || './data';

async function main() {
  // Initialize services
  const storage = new StorageService(DATA_DIR);
  await storage.initialize();
  
  const trackManager = new TrackManager(storage);
  await trackManager.initialize();
  
  const leaderboardManager = new LeaderboardManager(storage);
  
  const roomManager = new RoomManager(trackManager, leaderboardManager);
  
  // Create Express app
  const app = express();
  const httpServer = createServer(app);
  
  // Middleware
  app.use(compression());
  app.use(cors({
    origin: process.env['NODE_ENV'] === 'production' ? false : CLIENT_URL,
    credentials: true,
  }));
  app.use(express.json());
  
  // API routes
  app.use('/api', createApiRoutes(trackManager, leaderboardManager, roomManager));
  
  // Serve static files in production
  if (process.env['NODE_ENV'] === 'production') {
    // Client build is at dist/client, server runs from dist/server
    const clientDist = path.join(__dirname, '../client');
    if (!fs.existsSync(clientDist)) {
      console.warn(`Warning: Client dist not found at ${clientDist}`);
    }
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }
  
  // Socket.io setup
  const io = new Server(httpServer, {
    cors: {
      origin: process.env['NODE_ENV'] === 'production' ? false : CLIENT_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });
  
  // Initialize socket handler
  const socketHandler = new SocketHandler(io, roomManager);
  socketHandler.initialize();
  
  // Start server
  httpServer.listen(PORT, () => {
    console.log(`🏎️  Car Game server running on port ${PORT}`);
    console.log(`   Environment: ${process.env['NODE_ENV'] || 'development'}`);
    console.log(`   Data directory: ${DATA_DIR}`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    roomManager.shutdown();
    httpServer.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
