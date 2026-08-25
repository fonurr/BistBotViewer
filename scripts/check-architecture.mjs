import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const errors = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

for (const file of await walk(sourceRoot)) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const text = await readFile(file, 'utf8');

  if (relative.startsWith('src/components/') && /from\s+['"][^'"]*pages\//.test(text)) {
    errors.push(`${relative}: components may not import pages`);
  }

  const isBoundary = relative.startsWith('src/bistApi/') || relative.startsWith('src/priceApi/');
  const isServerBoundary =
    relative.startsWith('src/bistApi/server/') || relative.startsWith('src/priceApi/server/');
  if (
    !isBoundary &&
    /(?:\bfetch\s*\(|\bnew\s+EventSource\s*\(|\b(?:window|globalThis)\.fetch\s*\()/.test(text)
  ) {
    errors.push(`${relative}: network access belongs in bistApi/ or priceApi/`);
  }

  if (!isServerBoundary && /from\s+['"](?:node:sqlite|better-sqlite3|sqlite3)['"]/.test(text)) {
    errors.push(`${relative}: database access belongs in a server-side API boundary worker`);
  }

  if (
    !isServerBoundary &&
    /from\s+['"]node:(?:fs|fs\/promises|path|worker_threads)['"]/.test(text)
  ) {
    errors.push(`${relative}: filesystem and worker access belongs in a server-side API boundary`);
  }

  if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(text)) {
    errors.push(`${relative}: viewer state must remain memory-only`);
  }

  if (
    /from\s+['"][^'"]*(?:initial design handoff|MatriksOrder|DailyDataAggregator)[^'"]*['"]/.test(
      text,
    )
  ) {
    errors.push(`${relative}: runtime code may not import handoff or sibling project files`);
  }

  if (
    (relative.startsWith('src/bistApi/') && /from\s+['"][^'"]*priceApi\//.test(text)) ||
    (relative.startsWith('src/priceApi/') && /from\s+['"][^'"]*bistApi\//.test(text))
  ) {
    errors.push(`${relative}: the two API boundaries must remain independent`);
  }

  if (
    !isBoundary &&
    /127\.0\.0\.1:(?:8788|8789)|MatriksOrder\/data|DailyDataAggregator\/data/.test(text)
  ) {
    errors.push(`${relative}: upstream locations belong in an API boundary`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries are intact.');
}
