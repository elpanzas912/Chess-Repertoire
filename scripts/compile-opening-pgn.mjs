import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(path.join(root, 'mastery_courses', 'courses.json'), 'utf8'),
);

function sourceFilename(slug) {
  if (slug === 'caro-kann') return 'caro-kann_mastery.pgn';
  return `${slug.replaceAll('-', '_')}_mastery.pgn`;
}

function outputFilename(slug) {
  if (slug === 'caro-kann') return 'caro-kann_mastery_data.json';
  return `${slug.replaceAll('-', '_')}_mastery_data.json`;
}

function splitGames(pgn) {
  return pgn
    .trim()
    .split(/\r?\n(?=\[Event )/)
    .map((game) => game.trim())
    .filter(Boolean);
}

function formatMoves(moves) {
  return moves
    .map((move, index) => {
      const moveNumber = Math.floor(index / 2) + 1;
      return index % 2 === 0 ? `${moveNumber}. ${move}` : move;
    })
    .join(' ');
}

function commonPrefix(histories) {
  const shortest = Math.min(...histories.map((history) => history.length));
  const prefix = [];
  for (let index = 0; index < shortest; index += 1) {
    const move = histories[0][index];
    if (!histories.every((history) => history[index] === move)) break;
    prefix.push(move);
  }
  return prefix;
}

function buildOpening(slug, metadata, pgn) {
  const lines = [];
  const lineNames = {};
  const descriptions = {};
  const histories = [];
  const seenLines = new Set();

  for (const [index, gamePgn] of splitGames(pgn).entries()) {
    const chess = new Chess();
    try {
      chess.loadPgn(gamePgn);
    } catch (error) {
      throw new Error(`${slug}: invalid PGN game ${index + 1}: ${error.message}`);
    }

    const history = chess.history({ verbose: true });
    const sanMoves = history.map((move) => move.san);
    const line = formatMoves(sanMoves);
    const variation = chess.getHeaders().Variation?.trim();

    if (!line) throw new Error(`${slug}: game ${index + 1} has no moves`);
    if (seenLines.has(line)) throw new Error(`${slug}: duplicate line in game ${index + 1}`);
    seenLines.add(line);
    lines.push(line);
    histories.push(sanMoves);

    if (variation && !/^Variation \d+$/i.test(variation)) {
      lineNames[line] = variation;
    }

    for (const { fen, comment } of chess.getComments()) {
      const normalized = comment.trim();
      if (!normalized) continue;
      if (descriptions[fen] && descriptions[fen] !== normalized) {
        throw new Error(`${slug}: conflicting dialogue for FEN "${fen}"`);
      }
      descriptions[fen] = normalized;
    }
  }

  const sharedMoves = commonPrefix(histories);
  const sharedPosition = new Chess();
  for (const move of sharedMoves) sharedPosition.move(move);

  return {
    id: metadata.id,
    displayName: metadata.displayName,
    playerSide: metadata.playerSide,
    lines,
    lineNames,
    lineCount: lines.length,
    sharedOpeningPgn: formatMoves(sharedMoves),
    sharedOpeningFen: sharedPosition.fen(),
    descriptions,
  };
}

for (const [slug, metadata] of Object.entries(manifest)) {
  const filename = sourceFilename(slug);
  const pgn = await readFile(path.join(root, 'mastery_courses', 'pgn', filename), 'utf8');
  const opening = buildOpening(slug, metadata, pgn);
  const output = path.join(root, 'mastery_courses', 'json', outputFilename(slug));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify([{ opening }], null, 2)}\n`);
}

await import('./build-opening-data.mjs');
