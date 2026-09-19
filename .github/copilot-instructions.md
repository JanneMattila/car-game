# Car Game Repository Instructions

## Project structure

- This is a TypeScript multiplayer racing game with a single root [package.json](../package.json) for client and server dependencies.
- [client/src](../client/src) contains the React UI, PixiJS renderer, client prediction, and Zustand state.
- [server](../server) contains the Express API, Socket.IO handlers, race management, and Matter.js physics.
- [shared](../shared) contains shared types, constants, and utilities. Keep network messages, track definitions, and physics behavior consistent across the server, browser client, and [console client](../console-client).
- [data](../data) stores track JSON, leaderboards, and replays. Preserve existing data; do not change it incidentally during validation.
- Read [README.md](../README.md) for setup and deployment details. For track editor work, consult the [track-editor skill](skills/track-editor/SKILL.md) and [track documentation](../track.md).

## Development

- Run commands from the repository root. Use `npm install` when dependencies need to be installed.
- Start both development servers with `npm run dev`, or use `npm run dev:server` and `npm run dev:client` separately. Reuse existing running servers rather than starting duplicates.
- The browser client runs at `http://localhost:5173`; the server defaults to `http://localhost:3000`. Vite proxies `/api` and `/socket.io` to the server.
- Use `npm run dev:console` for the interactive console client.
- Server configuration uses `PORT`, `CLIENT_URL`, `DATA_DIR`, and `NODE_ENV`; keep credentials and environment-specific settings out of source code.
- Follow existing TypeScript and ES module conventions. Use shared definitions instead of duplicating protocol types or game constants.
- Follow the repository's ESLint and Prettier configuration: two-space indentation, single quotes, semicolons, and a 100-character print width. Avoid unrelated formatting changes.

## Validation

- Build production artifacts with `npm run localbuild`, or use `npm run build:server` / `npm run build:client` for scoped changes. `npm run build` is intentionally a no-op, not a validation command.
- Run `npm run lint` for code changes. Bundling does not type-check; use `npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p client\tsconfig.json` for the affected code.
- Run `npm test` for race lifecycle regression tests. Also validate affected gameplay in the browser, using multiple clients for multiplayer changes. [test-client.mjs](../test-client.mjs) is a specialized wrap-around diagnostic that requires a running server and its configured track, not a general test suite.
- For UI changes, verify the affected screen in the browser. Documentation-only changes do not require starting the app or running builds.
- Build output in `dist` is generated; edit source files instead.

## Deployment

- Deploy only when requested. Use `.\deploy-to-azure.ps1` and an authenticated Azure CLI.
- The deployment script builds and packages the app. Use `-SkipBuild` only when production artifacts are already current.
- The [deployment workflow](workflows/deploy-to-azure.yml) uses Node.js 24 and runs on pushes to `main` or manual dispatch.