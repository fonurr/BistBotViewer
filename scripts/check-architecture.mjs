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

  // The three data boundaries: MatriksOrder, DailyDataAggregator, and BistData's
  // historical minutes. Each is the only module allowed to reach its own source.
  const boundaries = ['src/bistApi/', 'src/priceApi/', 'src/histApi/'];
  const isBoundary = boundaries.some((boundary) => relative.startsWith(boundary));
  const isServerBoundary = boundaries.some((boundary) => relative.startsWith(`${boundary}server/`));
  if (
    !isBoundary &&
    /(?:\bfetch\s*\(|\bnew\s+EventSource\s*\(|\b(?:window|globalThis)\.fetch\s*\()/.test(text)
  ) {
    errors.push(`${relative}: network access belongs in bistApi/, priceApi/ or histApi/`);
  }

  if (
    !isServerBoundary &&
    /from\s+['"](?:node:sqlite|better-sqlite3|sqlite3|@duckdb\/[^'"]*)['"]/.test(text)
  ) {
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
    /from\s+['"][^'"]*(?:initial design handoff|MatriksOrder|DailyDataAggregator|BistData)[^'"]*['"]/.test(
      text,
    )
  ) {
    errors.push(`${relative}: runtime code may not import handoff or sibling project files`);
  }

  for (const boundary of boundaries) {
    if (!relative.startsWith(boundary)) continue;
    const others = boundaries.filter((other) => other !== boundary);
    for (const other of others) {
      const module = other.slice('src/'.length, -1);
      if (new RegExp(`from\\s+['"][^'"]*${module}/`).test(text)) {
        errors.push(`${relative}: the three API boundaries must remain independent`);
      }
    }
  }

  if (
    !isBoundary &&
    /127\.0\.0\.1:(?:8788|8789)|MatriksOrder\/data|DailyDataAggregator\/data|BistData\/data/.test(
      text,
    )
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
