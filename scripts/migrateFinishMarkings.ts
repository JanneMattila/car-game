import assert from 'node:assert/strict';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitRaceGate, validateTrack, type Track } from '../shared/index';

export function migrateFinishMarkings(track: Track): Track {
  return {
    ...track,
    elements: track.elements.map(element => {
      if (element.type !== 'finish' || element.properties?.finishVisibleWidth !== undefined) {
        return element;
      }
      // The circuit pack has 90-unit runoff and 14-unit walls: 83 units to each face.
      const extraWidth = fitRaceGate(track, element) === element ? 166 : 0;
      const x = element.x - extraWidth / 2;
      return {
        ...element,
        x,
        position: { ...element.position, x },
        width: element.width + extraWidth,
        properties: {
          ...element.properties,
          finishVisibleWidth: element.width,
          finishVisibleOffset: element.properties?.finishVisibleOffset ?? 0,
        },
      };
    }),
  };
}

async function main() {
  const directory = fileURLToPath(new URL('../data/tracks/', import.meta.url));
  const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
  const updates = await Promise.all(
    files.map(async file => {
      const filename = path.join(directory, file);
      const original: Track = JSON.parse(await readFile(filename, 'utf8'));
      const migrated = migrateFinishMarkings(original);
      assert.deepEqual(
        { ...migrated, elements: migrated.elements.filter(el => el.type !== 'finish') },
        { ...original, elements: original.elements.filter(el => el.type !== 'finish') }
      );
      for (const before of original.elements.filter(el => el.type === 'finish')) {
        const after = migrated.elements.find(el => el.id === before.id)!;
        assert.equal(after.x + after.width / 2, before.x + before.width / 2);
        assert.equal(after.y + after.height / 2, before.y + before.height / 2);
        assert.equal(after.rotation, before.rotation);
      }
      const validation = validateTrack(migrated);
      if (!validation.isValid) {
        throw new Error(`${file}: ${validation.errors.map(error => error.message).join('; ')}`);
      }
      return { filename, changed: JSON.stringify(original) !== JSON.stringify(migrated), migrated };
    })
  );
  for (const update of updates.filter(update => update.changed)) {
    const temporary = `${update.filename}.finish-migration.tmp`;
    await writeFile(temporary, `${JSON.stringify(update.migrated, null, 2)}\n`);
    await rename(temporary, update.filename);
  }
  console.log(
    `Updated ${updates.filter(update => update.changed).length} of ${files.length} tracks; non-finish data and crossing planes preserved.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
