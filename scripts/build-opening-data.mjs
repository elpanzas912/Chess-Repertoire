import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const courseDir = path.join(root, 'mastery_courses', 'json');
const publicOutput = path.join(root, 'data', 'openings-catalog.json');
const webPublicOutput = path.join(root, 'public', 'data', 'openings-catalog.json');
const privateOutput = path.join(
  root,
  'supabase',
  'storage',
  'private-opening-data',
  'openings.json',
);

function slugFromFilename(filename) {
  return filename
    .replace(/_mastery_data\.json$/, '')
    .replaceAll('_', '-');
}

function firstDescription(opening) {
  return Object.values(opening.descriptions ?? {}).find(
    (description) => typeof description === 'string' && description.trim(),
  ) ?? '';
}

function validateOpening(slug, opening, filename) {
  if (!opening || typeof opening !== 'object') {
    throw new Error(`${filename}: missing opening object`);
  }
  if (!opening.id || !opening.displayName) {
    throw new Error(`${filename}: missing opening id or displayName`);
  }
  if (!['w', 'b'].includes(opening.playerSide)) {
    throw new Error(`${filename}: playerSide must be "w" or "b"`);
  }
  if (!Array.isArray(opening.lines) || opening.lines.length === 0) {
    throw new Error(`${filename}: lines must be a non-empty array`);
  }
  if (opening.lineCount !== opening.lines.length) {
    throw new Error(
      `${filename}: lineCount ${opening.lineCount} does not match ${opening.lines.length} lines`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`${filename}: generated invalid slug "${slug}"`);
  }
}

const files = (await readdir(courseDir))
  .filter((filename) => filename.endsWith('_mastery_data.json'))
  .sort();

const openings = {};
const catalog = {};
const ids = new Set();

for (const filename of files) {
  const slug = slugFromFilename(filename);
  const parsed = JSON.parse(await readFile(path.join(courseDir, filename), 'utf8'));
  const opening = Array.isArray(parsed) ? parsed[0]?.opening : parsed.opening;

  validateOpening(slug, opening, filename);

  if (openings[slug]) {
    throw new Error(`${filename}: duplicate slug "${slug}"`);
  }
  if (ids.has(opening.id)) {
    throw new Error(`${filename}: duplicate opening id "${opening.id}"`);
  }
  ids.add(opening.id);

  openings[slug] = opening;
  catalog[slug] = {
    id: opening.id,
    displayName: opening.displayName,
    playerSide: opening.playerSide,
    lineCount: opening.lineCount,
    description: firstDescription(opening),
  };
}

await mkdir(path.dirname(publicOutput), { recursive: true });
await mkdir(path.dirname(webPublicOutput), { recursive: true });
await mkdir(path.dirname(privateOutput), { recursive: true });
await writeFile(publicOutput, `${JSON.stringify({ openings: catalog }, null, 2)}\n`);
await writeFile(webPublicOutput, `${JSON.stringify({ openings: catalog }, null, 2)}\n`);
await writeFile(privateOutput, `${JSON.stringify({ openings }, null, 2)}\n`);

console.log(`Generated ${files.length} openings.`);
console.log(`Public catalog: ${path.relative(root, publicOutput)}`);
console.log(`Web public catalog: ${path.relative(root, webPublicOutput)}`);
console.log(`Private Storage payload: ${path.relative(root, privateOutput)}`);
