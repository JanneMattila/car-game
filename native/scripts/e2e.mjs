#!/usr/bin/env node
// End-to-end test of the native game flow:
//   web server (profiles/lobby/tracks API) -> spawned cg_server -> two cg_bot AI drivers.
// Scenario "race":  two lobby bots with simulated latency that changes during the race, plus one
//                   server-side bot. Verifies results, leaderboard entries and return to lobby.
// Scenario "crash": the game server is killed mid-race; both bots must detect the loss and the
//                   lobby must be back in "waiting" with an explanatory message.
//
// Usage (from the repository root, after building native/build/msvc or native/build/release):
//   node native/scripts/e2e.mjs [--bin DIR] [--docker IMAGE] [--port 3200] [--game-port 5555]
//                               [--track bristol-short-oval] [--laps 2] [--only race|crash] [--verbose]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';

const args = { port: 3200, gamePort: 5555, track: 'bristol-short-oval', laps: 2 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--bin') args.bin = next();
  else if (a === '--docker') args.docker = next();
  else if (a === '--port') args.port = Number(next());
  else if (a === '--game-port') args.gamePort = Number(next());
  else if (a === '--track') args.track = next();
  else if (a === '--laps') args.laps = Number(next());
  else if (a === '--only') args.only = next();
  else if (a === '--verbose') args.verbose = true;
  else {
    console.error(`unknown argument ${a}`);
    process.exit(2);
  }
}

function findBinDir() {
  if (args.bin) return path.resolve(args.bin);
  for (const dir of ['native/build/msvc', 'native/build/release', 'native/build']) {
    const full = path.join(root, dir);
    if (fs.existsSync(path.join(full, `cg_bot${exe}`))) return full;
  }
  throw new Error('cg_bot not found; build native/ first or pass --bin');
}

const binDir = findBinDir();
const api = `http://127.0.0.1:${args.port}`;
const children = new Set();
let failures = 0;

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

function check(condition, message) {
  if (condition) log(`PASS ${message}`);
  else {
    failures++;
    log(`FAIL ${message}`);
  }
}

function run(name, command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(child);
  const out = { stdout: '', events: [] };
  const onLine = stream => line => {
    if (stream === 'stdout') {
      out.stdout += `${line}\n`;
      if (line.startsWith('@@BOT ')) out.events.push(JSON.parse(line.slice(6)));
    }
    if (args.verbose || line.includes('ERROR')) console.log(`  ${name}| ${line}`);
  };
  for (const stream of ['stdout', 'stderr']) {
    let buffer = '';
    child[stream].on('data', chunk => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine(stream)(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    });
  }
  out.exit = new Promise(resolve =>
    child.on('exit', code => {
      children.delete(child);
      resolve(code);
    })
  );
  out.child = child;
  return out;
}

function killAll() {
  for (const child of children) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    } else child.kill('SIGKILL');
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function startBots(prefix, hostScript, guestScript) {
  const common = ['--api', api, '--laps', String(args.laps), '--no-stdin', '--stats-interval', '5'];
  const host = run(`${prefix}-host`, path.join(binDir, `cg_bot${exe}`), [
    ...common,
    '--nickname',
    `${prefix}Host`,
    '--create',
    args.track,
    '--start-when',
    '2',
    '--server-bots',
    '1',
    '--skill',
    'hard',
    '--latency',
    '40',
    '--jitter',
    '5',
    '--script',
    hostScript,
    '--seed',
    '11',
  ]);
  const guest = run(`${prefix}-guest`, path.join(binDir, `cg_bot${exe}`), [
    ...common,
    '--nickname',
    `${prefix}Guest`,
    '--join-any',
    '--skill',
    'medium',
    '--latency',
    '120',
    '--jitter',
    '15',
    '--loss',
    '2',
    '--script',
    guestScript,
    '--seed',
    '22',
  ]);
  return { host, guest };
}

const final = bot => bot.events.filter(e => e.type !== 'lobby').at(-1);

async function raceScenario() {
  log('scenario race: 2 lobby bots + 1 server bot, latency changes during the race');
  const { host, guest } = startBots(
    'Race',
    '4:latency=150;9:jitter=25;14:latency=20;18:loss=5;22:loss=0',
    '5:latency=40;10:latency=250;15:latency=80;20:jitter=0'
  );
  const [hostCode, guestCode] = await Promise.all([host.exit, guest.exit]);
  const h = final(host);
  const g = final(guest);
  check(hostCode === 0 && h?.outcome === 'finished', `host finished (exit ${hostCode})`);
  check(guestCode === 0 && g?.outcome === 'finished', `guest finished (exit ${guestCode})`);
  check(h?.results?.length === 3, `3 cars in results (${h?.results?.length})`);
  check(
    h?.lobbyStatus === 'waiting' && g?.lobbyStatus === 'waiting',
    'both bots returned to the lobby'
  );
  for (const [name, s] of [
    ['host', h],
    ['guest', g],
  ]) {
    if (!s) continue;
    log(
      `${name}: rank ${s.rank} total ${(s.finishMs / 1000).toFixed(2)}s rtt ${s.rttMs?.toFixed?.(0)}ms ` +
        `mispredictions ${s.mispredictions} avgCorr ${s.avgCorrectionPx?.toFixed?.(2)}px resyncs ${s.hardResyncs}`
    );
  }
  const board = await getJson(`${api}/api/leaderboards/${args.track}`);
  const text = JSON.stringify(board);
  check(text.includes('RaceHost') && text.includes('RaceGuest'), 'leaderboard has both drivers');
}

async function killGameServer() {
  const lobby = await waitFor(
    async () => {
      const debug = await getJson(`${api}/api/native/debug`);
      return debug.lobbies.find(l => l.status === 'running' && l.match?.ready);
    },
    20000,
    'running game server'
  );
  await sleep(6000);
  if (args.docker) {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', `publish=${lobby.match.port}/udp`])
      .toString()
      .trim();
    log(`killing container ${ids} (port ${lobby.match.port})`);
    if (ids) execFileSync('docker', ['kill', ...ids.split(/\s+/)], { stdio: 'ignore' });
  } else {
    log(`killing cg_server pid ${lobby.match.pid} (port ${lobby.match.port})`);
    process.kill(lobby.match.pid, 'SIGKILL');
  }
}

async function crashScenario() {
  log('scenario crash: game server is killed mid-race');
  const { host, guest } = startBots('Crash', '8:latency=90', '8:latency=60');
  await killGameServer();
  const [hostCode, guestCode] = await Promise.all([host.exit, guest.exit]);
  const h = final(host);
  const g = final(guest);
  check(
    h?.outcome === 'lost' && g?.outcome === 'lost',
    `both bots detected the lost server (${h?.outcome}/${g?.outcome})`
  );
  check(
    hostCode === 3 && guestCode === 3,
    `exit codes report a lost server (${hostCode}/${guestCode})`
  );
  check(
    h?.lobbyStatus === 'waiting' && /crash|lost|stopped/i.test(h?.lobbyMessage ?? ''),
    `lobby is waiting with message "${h?.lobbyMessage}"`
  );
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-'));
  fs.cpSync(path.join(root, 'data', 'tracks'), path.join(dataDir, 'tracks'), { recursive: true });
  const env = {
    ...process.env,
    PORT: String(args.port),
    DATA_DIR: dataDir,
    NODE_ENV: 'development',
    NATIVE_PORT_BASE: String(args.gamePort),
    NATIVE_PUBLIC_HOST: '127.0.0.1',
  };
  if (args.docker) {
    env.NATIVE_SERVER_COMMAND = `docker run --rm -i -p {port}:5555/udp ${args.docker} --config - --port 5555`;
    env.NATIVE_READY_TIMEOUT_MS = '30000';
  } else {
    env.NATIVE_SERVER_PATH = path.join(binDir, `cg_server${exe}`);
  }
  log(
    `bin ${binDir}; data ${dataDir}; ${args.docker ? `docker image ${args.docker}` : 'local cg_server'}`
  );
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  run('web', process.execPath, [tsx, path.join(root, 'server', 'index.ts')], { env, cwd: root });
  try {
    await waitFor(async () => (await fetch(`${api}/api/native/lobbies`)).ok, 60000, 'web server');
    log('web server is up');
    if (args.only !== 'crash') await raceScenario();
    if (args.only !== 'race') await crashScenario();
  } catch (err) {
    failures++;
    log(`ERROR ${err.message}`);
  } finally {
    killAll();
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  log(failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});
main();
