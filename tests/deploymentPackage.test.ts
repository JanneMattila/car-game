import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StorageService } from '../server/storage/storageService';
import { TrackManager } from '../server/tracks/trackManager';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts', 'CreateDeploymentPackage.ps1');
const powershell = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const packageContent = JSON.stringify({
  name: 'deployment-fixture',
  type: 'module',
  scripts: { start: 'node dist/server/index.js' },
  dependencies: { express: '^4.18.0' },
  devDependencies: { typescript: '^5.4.0' },
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'car-game-package-test-'));
  const source = path.join(directory, 'source with spaces');
  await mkdir(path.join(source, 'dist', 'server'), { recursive: true });
  await mkdir(path.join(source, 'dist', 'client'), { recursive: true });
  await mkdir(path.join(source, 'data', 'tracks'), { recursive: true });
  await writeFile(path.join(source, 'dist', 'server', 'index.js'), '// server fixture');
  await writeFile(path.join(source, 'dist', 'client', 'index.html'), '<html></html>');
  await writeFile(path.join(source, 'package.json'), packageContent);
  execFileSync('git', ['-C', source, 'init', '--quiet']);
  return { directory, source, archive: path.join(directory, 'deployment.zip') };
}

function createPackage(source: string, archive: string) {
  return execFileSync(
    powershell,
    ['-NoProfile', '-File', script, '-SourceDirectory', source, '-DestinationPath', archive],
    { encoding: 'utf8', stdio: 'pipe' }
  );
}

test('deployment includes every committed circuit, loads the catalog and preserves local data', async () => {
  const { directory, source, archive } = await fixture();
  try {
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '--', 'data'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/)
      .filter(file => /^data\/tracks\/[^/]+\.json$/.test(file));
    assert.ok(tracked.length >= 28);
    for (const file of tracked) {
      await copyFile(path.join(root, file), path.join(source, file));
    }
    execFileSync('git', ['-C', source, 'add', '--', 'data']);

    const privateFiles = [
      path.join('data', 'tracks', 'my-custom-track.json'),
      path.join('data', 'leaderboards', 'scores.json'),
      path.join('data', 'replays', 'race.json'),
      path.join('server', 'data', 'tracks', 'obsolete.json'),
    ];
    for (const file of privateFiles) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), '{"private":"preserve"}');
    }

    assert.ok(
      createPackage(source, archive).includes(`Packaged ${tracked.length} committed circuits`)
    );
    const extracted = path.join(directory, 'extracted');
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    execFileSync(
      powershell,
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)}`,
      ],
      { stdio: 'pipe' }
    );

    const expected = tracked.map(file => path.basename(file)).sort();
    assert.deepEqual((await readdir(path.join(extracted, 'data', 'tracks'))).sort(), expected);
    assert.deepEqual(await readdir(path.join(extracted, 'data')), ['tracks']);
    const productionPackage = JSON.parse(
      await readFile(path.join(extracted, 'package.json'), 'utf8')
    );
    assert.equal(productionPackage.devDependencies, undefined);
    assert.deepEqual(productionPackage.dependencies, { express: '^4.18.0' });
    assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), packageContent);
    for (const file of privateFiles) {
      assert.equal(await readFile(path.join(source, file), 'utf8'), '{"private":"preserve"}');
    }
    for (const file of tracked) {
      assert.deepEqual(
        await readFile(path.join(source, file)),
        await readFile(path.join(root, file))
      );
    }

    const storage = new StorageService(path.join(extracted, 'data'));
    await storage.initialize();
    const manager = new TrackManager(storage);
    await manager.initialize();
    assert.equal(manager.getTrackList().length, tracked.length);
    assert.ok(manager.getTrack('suzuka-grand-prix'));
    assert.ok(manager.getTrack('silverstone-grand-prix'));
    assert.ok(manager.getTrack('bristol-short-oval'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment refuses an empty committed catalog without touching source files', async () => {
  const { directory, source, archive } = await fixture();
  try {
    await writeFile(path.join(source, 'data', 'tracks', 'local-only.json'), '{"private":true}');
    assert.throws(() => createPackage(source, archive), /No committed circuits found/);
    assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), packageContent);
    assert.equal(
      await readFile(path.join(source, 'data', 'tracks', 'local-only.json'), 'utf8'),
      '{"private":true}'
    );
    assert.ok(!(await readdir(directory)).includes('deployment.zip'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed packaging preserves source tracks and the development manifest', async () => {
  const { directory, source, archive } = await fixture();
  try {
    const track = path.join(source, 'data', 'tracks', 'circuit.json');
    await writeFile(track, '{"id":"circuit"}');
    execFileSync('git', ['-C', source, 'add', '--', 'data']);
    await writeFile(path.join(source, 'package.json'), 'invalid JSON');
    assert.throws(() => createPackage(source, archive), /ConvertFrom-Json/);
    assert.equal(await readFile(track, 'utf8'), '{"id":"circuit"}');
    assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), 'invalid JSON');
    assert.ok(!(await readdir(directory)).includes('deployment.zip'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment refuses a missing tracked circuit instead of silently omitting it', async () => {
  const { directory, source, archive } = await fixture();
  try {
    const track = path.join(source, 'data', 'tracks', 'missing.json');
    await writeFile(track, '{"id":"missing"}');
    execFileSync('git', ['-C', source, 'add', '--', 'data']);
    await rm(track);
    assert.throws(
      () => createPackage(source, archive),
      /Required deployment content not found: data\/tracks\/missing.json/
    );
    assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), packageContent);
    assert.ok(!(await readdir(directory)).includes('deployment.zip'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
