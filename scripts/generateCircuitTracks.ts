import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CIRCUIT_TEMPLATES, createCircuitTrack } from '../shared/index';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  for (const id of requested) {
    if (!CIRCUIT_TEMPLATES.some(template => template.id === id)) {
      throw new Error(`Unknown curated track: ${id}`);
    }
  }
  const templates =
    requested.length === 0
      ? CIRCUIT_TEMPLATES
      : CIRCUIT_TEMPLATES.filter(template => requested.includes(template.id));
  for (const template of templates) {
    const track = createCircuitTrack(template.id);
    const target = fileURLToPath(new URL(`../data/tracks/${track.id}.json`, import.meta.url));
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(track, null, 2)}\n`);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(
      `Created ${track.name}: ${track.width} x ${track.height}, ${track.elements.length} elements.`
    );
  }
}
