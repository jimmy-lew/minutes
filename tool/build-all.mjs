#!/usr/bin/env node
// Build every Markdown file in the repo (outside tool/) into HTML next to it,
// plus an index.html per folder (newest first) and one at the root listing the folders.
// Pass --watch to rebuild on changes.

import { readdirSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, pageMeta, renderIndex } from './minutes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STYLE = join(HERE, 'style.css');
const SKIP = new Set(['tool', 'node_modules', '_site']);
const SITE = 'Minutes';

function* markdown(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* markdown(p);
    // index.html is generated, so an index.md would collide with it.
    else if (/\.md$/i.test(e.name) && !/^(readme|index)\.md$/i.test(e.name)) yield p;
  }
}

function buildAll() {
  const css = readFileSync(STYLE, 'utf8');
  const folders = new Map(); // dir → entries
  let failed = 0;

  for (const file of markdown(ROOT)) {
    const name = basename(file, '.md');
    const rel = relative(ROOT, file);
    try {
      const src = readFileSync(file, 'utf8');
      writeFileSync(join(dirname(file), `${name}.html`), render(src, { name, css }));
      const dir = dirname(file);
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir).push({ href: `${name}.html`, ...pageMeta(src, name) });
      console.error(`✓ ${rel}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${rel}: ${e.message}`);
    }
  }

  const top = [];
  for (const [dir, entries] of folders) {
    if (dir === ROOT) {
      top.push(...entries);
      continue;
    }
    const folder = relative(ROOT, dir);
    const count = `${entries.length} meeting${entries.length === 1 ? '' : 's'}`;
    writeFileSync(join(dir, 'index.html'), renderIndex(entries, {
      title: folder.split(sep).at(-1),
      crumb: [[SITE, '../'.repeat(folder.split(sep).length)], ...folder.split(sep)],
      lede: count,
      css,
    }));
    console.error(`✓ ${folder}/index.html`);
    const latest = entries.reduce((d, e) => (e.date > d ? e.date : d), null);
    top.push({ href: `${folder.split(sep).join('/')}/`, titleHtml: folder, summaryHtml: count, date: latest });
  }
  if (top.length) {
    writeFileSync(join(ROOT, 'index.html'), renderIndex(top, { title: SITE, css }));
    console.error('✓ index.html');
  }
  return failed;
}

const failed = buildAll();

if (process.argv.includes('--watch')) {
  let timer;
  watch(ROOT, { recursive: true }, (_, file) => {
    if (!file || !(/\.md$/i.test(file) || file.endsWith('style.css'))) return;
    if (file.split(sep).some((p) => p === 'node_modules')) return;
    clearTimeout(timer);
    timer = setTimeout(buildAll, 80);
  });
  console.error('Watching for changes… (Ctrl-C to stop)');
} else if (failed) {
  process.exit(1);
}
