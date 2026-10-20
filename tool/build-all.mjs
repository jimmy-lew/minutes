#!/usr/bin/env node
// Build every Markdown file in the repo (outside tool/) into HTML next to it.
// Extra args (e.g. --watch) are passed through to minutes.mjs.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SKIP = new Set(['tool', 'node_modules', '_site', '.git', '.github']);

function* markdown(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* markdown(p);
    else if (e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md') yield relative(process.cwd(), p);
  }
}

const files = [...markdown(ROOT)];
if (files.length === 0) {
  console.error('No Markdown files found.');
  process.exit(0);
}
const { status } = spawnSync(process.execPath, [join(HERE, 'minutes.mjs'), ...files, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
