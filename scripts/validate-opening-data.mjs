import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(
  await readFile(path.join(root, 'data', 'openings-catalog.json'), 'utf8'),
).openings;
const payload = JSON.parse(
  await readFile(
    path.join(root, 'supabase', 'storage', 'private-opening-data', 'openings.json'),
    'utf8',
  ),
).openings;

const catalogSlugs = Object.keys(catalog).sort();
const payloadSlugs = Object.keys(payload).sort();

if (JSON.stringify(catalogSlugs) !== JSON.stringify(payloadSlugs)) {
  throw new Error('Public catalog and private payload contain different openings');
}

let totalLines = 0;
for (const slug of payloadSlugs) {
  const opening = payload[slug];
  if (!Array.isArray(opening.lines) || opening.lines.length !== opening.lineCount) {
    throw new Error(`${slug}: invalid line count`);
  }
  if (!catalog[slug].description) {
    throw new Error(`${slug}: missing public description`);
  }
  totalLines += opening.lineCount;
}

console.log(`Validated ${payloadSlugs.length} openings and ${totalLines} lines.`);
