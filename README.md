# 🏎️ Car Game

A multiplayer browser-based racing game built with React, Node.js, Socket.IO, and Matter.js physics engine. Features real-time multiplayer racing with custom track editor, element-based track system, and responsive arcade-style physics.

## ✨ Features

- **Real-time Multiplayer**: Up to 8 players per race with WebSocket communication
- **Custom Track Editor**: Visual track designer with drag-and-drop elements
- **Element-Based Tracks**: Modular track system with spawn points, walls, barriers, checkpoints, and finish lines
- **Arcade Physics**: Responsive car handling with speed limits, nitro boosts, and collision detection
- **Game Modes**: Host/join rooms, countdown timers, lap tracking, and race results
- **Modern Stack**: TypeScript, React 18, Node.js, Socket.IO, PixiJS, and Matter.js

## 🛠️ Technology Stack

### Frontend
- **React 18** - UI framework with hooks and functional components
- **TypeScript** - Type safety and enhanced development experience
- **PixiJS v8** - High-performance 2D graphics rendering
- **Vite** - Fast development server and build tool
- **React Router** - Client-side routing for game screens
- **Zustand** - Lightweight state management

### Backend
- **Node.js** - Server runtime with ES modules
- **Express** - Web application framework
- **Socket.IO** - Real-time bidirectional communication
- **Matter.js** - 2D physics engine for car dynamics
- **TypeScript** - Shared types between client and server
- **ESBuild** - Fast bundling for production

### Shared
- **TypeScript** - Shared interfaces, types, and constants
- **Monorepo Structure** - Organized codebase with shared dependencies

## 📋 Prerequisites

Before running the project, ensure you have:

- **Node.js 18+** - [Download from nodejs.org](https://nodejs.org/)

For Azure deployment:
- **Azure CLI** - [Install Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)
- **Azure Subscription** - Active Azure account
- **PowerShell** - For deployment script (Windows) or PowerShell Core (cross-platform)

## 🚀 Local Development

### 1. Clone Repository

```bash
git clone <repository-url>
cd car-game
```

### 2. Install Dependencies

```bash
npm install
```

This installs all dependencies for both client and server from the root package.json.

### 3. Start Development Servers

**Option A: Start Both Client and Server**
```bash
npm run dev
```

This runs both the client (Vite dev server) and server (Node.js with tsx) concurrently.

**Option B: Start Individually**
```bash
# Terminal 1 - Start server
npm run dev:server

# Terminal 2 - Start client
npm run dev:client
```

### 4. Access Application

- **Game Client**: http://localhost:5173
- **API Server**: http://localhost:3000
- **Socket.IO**: ws://localhost:3000 (WebSocket connection)

If port 5173 is occupied, use the client URL printed by Vite (for example,
http://localhost:5174). The browser uses same-origin `/api` and `/socket.io`
requests, which Vite proxies to the backend on port 3000.

Before creating or joining a room, choose a nickname with 2-16 characters
(letters, numbers, underscores, or hyphens). Invalid nicknames are shown in
the player settings or lobby; server errors appear in a dismissible banner.

After a race, choose **Play Again** to return to the same room. Ready states
are preserved, and the host can start the next race. Each race resets cars,
lap times, race timing, and results. Players still viewing results join the
new countdown automatically.

### 5. Development Workflow

- Client auto-reloads on file changes (Vite HMR)
- Server auto-restarts on file changes (tsx watch mode)
- TypeScript compilation happens in real-time
- Shared types ensure client-server consistency

### Gameplay Timing

- Each mounted game renderer owns one Pixi application and one frame callback.
  Leaving a race stops prediction immediately; cancelled asynchronous
  initialization cannot attach another canvas or restart an old loop.
- The server, browser, and console use the same continuous world coordinates.
  The network game store owns car reconciliation; each player has exactly one
  car sprite at its actual world position.
- On infinite tracks (`wrapAround`), terrain, walls, and race markers repeat.
  Cars never wrap or appear in other tile copies. A car driving north leaves
  a stationary observer's screen to the north and stays there until it returns.
  The minimap shows its true direction and distance.
- Wall physics loads neighboring tiles around each car and removes unused
  tiles. Cars in different world tiles cannot collide through map repetition.
  An explicit respawn selects the nearest repeated checkpoint.
- Server physics advances in fixed 60 Hz steps based on elapsed time, with
  catch-up capped at 100 ms per callback after a long stall.
- When validating movement, hold **ArrowUp** across track boundaries and repeat
  after **Play Again** and leaving/rejoining. Normal driving should not trigger
  large backward jumps or `[SNAP]` corrections in the **B** debug overlay.

### Two-player Console Testing

Create a private room in the browser, choose the Forever wrap-around track,
and increase the lap count to allow sustained testing. In a second PowerShell
terminal, join it using the room code:

```powershell
$env:ROOM_CODE = 'ABC123'
$env:NICKNAME = 'CircleBot'
$env:DRIVE_PATTERN = 'figure-eight'
$env:LOG_LEVEL = 'summary'
npm run dev:console
```

The console player readies automatically; the browser host starts the race.
Hold **ArrowUp** with **ArrowLeft** or **ArrowRight**, switch directions, then
brake with **ArrowDown**. Watch both cars through several turns and tile
boundaries. Unexpected position jumps or reconciliation snaps indicate a
movement regression.

Also test with `DRIVE_PATTERN=straight` while keeping the browser player
stationary. Let the console car cross several tile boundaries: it must leave
the screen once and never reappear on the opposite side. Its minimap direction
must remain consistent as its distance grows. Returning to the observer's
actual location is the only way to come back into view.

| Setting | Behavior |
| --- | --- |
| `ROOM_CODE` | Join an existing room. Omit to create and start a solo room. |
| `DRIVE_PATTERN=straight` | Accelerate without steering (default). |
| `DRIVE_PATTERN=circle-left` | Accelerate while steering left continuously. |
| `DRIVE_PATTERN=circle-right` | Accelerate while steering right continuously. |
| `DRIVE_PATTERN=figure-eight` | Alternate right and left steering every eight seconds. |

Driving patterns apply when automatic driving is enabled (the default).
Stop the console player with **Ctrl+C**. Run `npm test` for pattern and
infinite-world physics and position regression tests.

## 📁 Project Structure

```
car-game/
├── client/                 # React frontend application
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── game/          # Game-specific components (renderer, input)
│   │   ├── screens/       # Main game screens (menu, lobby, game, etc.)
│   │   ├── store/         # Zustand state management
│   │   ├── styles/        # Global CSS styles
│   │   └── utils/         # Client utility functions
│   ├── index.html         # HTML entry point
│   ├── vite.config.ts     # Vite configuration
│   └── tsconfig.json      # Client TypeScript config
├── server/                # Node.js backend application
│   ├── game/             # Game logic and physics
│   ├── leaderboards/     # Leaderboard management
│   ├── network/          # Socket.IO handlers
│   ├── routes/           # Express API routes
│   ├── storage/          # File system operations
│   ├── tracks/           # Track loading and management
│   ├── utils/            # Server utility functions
│   └── index.ts          # Server entry point
├── shared/               # Shared TypeScript definitions
│   ├── constants/        # Game and physics constants
│   ├── types/           # Interface definitions
│   └── utils/           # Shared utility functions
├── dist/                # Build output (generated)
│   ├── client/          # Built client static files
│   └── server/          # Built server files
├── data/                # Runtime data storage
│   ├── tracks/          # Track definition files (.json)
│   ├── leaderboards/    # Leaderboard data
│   └── replays/         # Race replay files
├── deploy-to-azure.ps1  # Azure deployment script
├── package.json         # Project dependencies and scripts
└── README.md           # This documentation file
```

## 🏗️ Available Scripts

### Development
- `npm run dev` - Start both client and server in development mode
- `npm run dev:client` - Start only the React client (port 5173)
- `npm run dev:server` - Start only the Node.js server (port 3000)

### Building
- `npm run localbuild` - Build both client and server for production
- `npm run build:client` - Build only the React client
- `npm run build:server` - Build only the Node.js server

### Production
- `npm start` - Start the production server (requires build first)

### Code Quality
- `npm test` - Run race lifecycle, delayed physics timer, and async renderer cleanup regression tests
- `npm run lint` - Run ESLint on all TypeScript files
- `npm run lint:fix` - Fix ESLint issues automatically
- `npm run format` - Format code with Prettier

## ☁️ Azure Deployment

The project includes a comprehensive PowerShell deployment script that handles building, packaging, and deploying to Azure App Service.

### 1. Prerequisites for Azure Deployment

**Install Azure CLI:**
```bash
# Windows (using winget)
winget install Microsoft.AzureCli

# macOS (using brew)
brew install azure-cli

# Or download from: https://aka.ms/installazurecliwindows
```

**Login to Azure:**
```bash
az login
```

### 2. Create Azure Resources

**Create Resource Group:**
```bash
az group create --name rg-app-services --location eastus
```

**Create App Service Plan:**
```bash
az appservice plan create \
  --name plan-car-game \
  --resource-group rg-app-services \
  --sku B1 \
  --is-linux
```

**Create Web App:**
```bash
az webapp create \
  --name your-car-game \
  --resource-group rg-app-services \
  --plan plan-car-game \
  --runtime "NODE:18-lts"
```

### 3. Deploy Application

**Basic Deployment:**
```powershell
.\deploy-to-azure.ps1 -AppName "your-car-game" -ResourceGroup "rg-app-services"
```

**Advanced Deployment Options:**
```powershell
# Deploy without rebuilding
.\deploy-to-azure.ps1 -AppName "your-car-game" -ResourceGroup "rg-app-services" -SkipBuild

# Preview deployment (dry run)
.\deploy-to-azure.ps1 -AppName "your-car-game" -ResourceGroup "rg-app-services" -WhatIf

# Deploy and open browser
.\deploy-to-azure.ps1 -AppName "your-car-game" -ResourceGroup "rg-app-services" -OpenBrowser
```

### 4. Deployment Script Features

The `deploy-to-azure.ps1` script automatically:

- ✅ Verifies Azure CLI installation and authentication
- ✅ Checks that the target App Service exists
- ✅ Builds both client and server applications
- ✅ Creates optimized deployment package (removes devDependencies)
- ✅ Configures App Service settings for Node.js
- ✅ Deploys using Azure App Service deployment API
- ✅ Provides useful post-deployment commands
- ✅ Handles cleanup of temporary files

### 5. Monitor Deployment

**View deployment logs:**
```bash
az webapp log tail --name your-car-game --resource-group rg-app-services
```

**Check application status:**
```bash
az webapp show --name your-car-game --resource-group rg-app-services
```

**Open application:**
```bash
az webapp browse --name your-car-game --resource-group rg-app-services
```

## 🔧 Environment Variables

The application currently uses default configuration but supports environment variables for production:

### Server Environment Variables

```bash
# Port configuration (default: 3000)
PORT=3000

# Node.js environment
NODE_ENV=production

# Data directory (default: ./data)
DATA_DIR=./data

# CORS origins (default: allows all in development)
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

### Azure App Service Configuration

The deployment script automatically sets these App Service settings:

```bash
SCM_DO_BUILD_DURING_DEPLOYMENT=true
NODE_ENV=production
```

## 🎮 How to Play

### 1. Start a Game
1. Open the application in your browser
2. Enter your player name
3. Create a room or join an existing room with a room code
4. Wait for other players to join
5. Host can start the countdown when ready

### 2. Racing Controls
- **W/↑** - Accelerate
- **S/↓** - Brake/Reverse
- **A/←** - Steer left
- **D/→** - Steer right
- **Space** - Nitro boost
- **R** - Respawn (if stuck)
- **Escape** - Pause menu

### 3. Track Editor
- Access the track editor from the main menu
- Drag and drop elements to design custom tracks
- Elements: Spawn points, walls, barriers, checkpoints, finish line
- Save and load custom tracks
- Test tracks in real-time

## 🐛 Troubleshooting

### Common Local Development Issues

**Port 3000 already in use:**
```bash
# Kill processes using port 3000
netstat -ano | findstr :3000
taskkill /PID <process_id> /F
```

**TypeScript compilation errors:**
```bash
# Clean build cache
rm -rf dist/
rm -f *.tsbuildinfo
npm run localbuild
```

**Dependencies issues:**
```bash
# Clean install
rm -rf node_modules package-lock.json
npm install
```

### Common Azure Deployment Issues

**Authentication failed:**
```bash
az login
az account set --subscription <subscription-id>
```

**App Service not found:**
- Verify App Service name and resource group
- Check that you have proper permissions
- Ensure the App Service exists in the correct Azure region

**Deployment timeout:**
- Monitor logs: `az webapp log tail --name <app-name> --resource-group <rg>`
- Check App Service configuration matches Node.js requirements
- Verify the deployment package isn't too large

**Runtime errors after deployment:**
```bash
# Check application logs
az webapp log config --application-logging true --name <app-name> --resource-group <rg>
az webapp log tail --name <app-name> --resource-group <rg>
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and commit: `git commit -m "Add feature"`
4. Run tests and lint: `npm run lint`
5. Push to your branch: `git push origin feature-name`
6. Submit a pull request

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🔗 Additional Resources

- [React Documentation](https://reactjs.org/docs/)
- [Socket.IO Documentation](https://socket.io/docs/)
- [Matter.js Documentation](https://brm.io/matter-js/)
- [PixiJS Documentation](https://pixijs.com/docs/)
- [Azure App Service Documentation](https://docs.microsoft.com/en-us/azure/app-service/)
- [Azure CLI Documentation](https://docs.microsoft.com/en-us/cli/azure/)