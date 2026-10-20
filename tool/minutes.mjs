#!/usr/bin/env node
// Markdown (+ optional YAML frontmatter) → self-contained meeting-minutes page.
// See README.md for the input format.

import { readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Marked } from 'marked';
import YAML from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLE_PATH = join(HERE, 'style.css');

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const stripTags = (html) =>
  html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const humanise = (key) => capitalise(String(key).replace(/[_-]+/g, ' ').trim());

const initials = (name) =>
  String(name).split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]).join('').slice(0, 2).toUpperCase();

function formatDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    return v.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  return m ? formatDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))) : null;
}

// ---------------------------------------------------------------- status pills

const STATUS_ALIASES = {
  good: 'good', done: 'good', ok: 'good',
  warn: 'warn', wip: 'warn', progress: 'warn',
  low: 'low', hold: 'low',
  bad: 'bad', blocked: 'bad',
  open: 'open', todo: 'open',
};
const STATUS_EMOJI = { '🟢': 'good', '✅': 'good', '🟡': 'warn', '🟠': 'warn', '🟣': 'low', '🔵': 'low', '🔴': 'bad', '⛔': 'bad', '⚪': 'open', '⚫': 'open' };
// Checked in order; first match wins. Used for "Status" table columns without an explicit marker.
const STATUS_WORDS = [
  ['bad', /\b(blocked|blocker|fail(ed|ing)?|overdue|broken|critical|down|cancell?ed)\b/i],
  ['open', /\b(open|to ?do|not started|tbd|tba|new|pending|unassigned)\b/i],
  ['warn', /\b(in progress|wip|ongoing|partial(ly)?|at risk|usable|bugs?|buggy|review|draft)\b/i],
  ['low', /\b(low|paused|on hold|deferred|backlog|later|outdated|stale|unused|under[- ]?\w+)\b/i],
  ['good', /\b(done|complete[d]?|closed|resolved|shipped|live|good|ok|on track|success\w*|healthy|stable|merged)\b/i],
];
const STATUS_KEYS = Object.keys(STATUS_ALIASES).join('|');
const EXPLICIT_PREFIX = new RegExp(`^(?:\\{(${STATUS_KEYS})\\}|(${Object.keys(STATUS_EMOJI).join('|')})\\uFE0F?)\\s*`, 'iu');

const pill = (kind, html) => `<span class="status s-${kind}">${html}</span>`;

function inferStatus(text) {
  for (const [kind, re] of STATUS_WORDS) if (re.test(text)) return kind;
  return 'open';
}

// ---------------------------------------------------------------- markdown setup

const CALLOUT_TONES = {
  blocker: 'orange', warning: 'orange', caution: 'orange', risk: 'orange',
  note: 'violet', info: 'violet', important: 'violet',
  tip: 'green', decision: 'green', decided: 'green', resolved: 'green', done: 'green',
  question: 'yellow',
  danger: 'red', critical: 'red',
};

const md = new Marked({ gfm: true });

// Parse a string of inline markdown with all extensions active.
const inline = (src) => new md.Parser(md.defaults).parseInline(md.Lexer.lexInline(String(src), md.defaults));

// Pull a trailing `{#id toc="Label"}` off a heading token, mutating it.
function takeHeadingAttrs(token) {
  const attrs = {};
  const last = token.tokens?.at(-1);
  if (last?.type !== 'text') return attrs;
  const m = /\s*\{((?:\s*(?:#[\w-]+|[\w-]+=(?:"[^"]*"|'[^']*'|[^\s}]+)))+)\s*\}\s*$/.exec(last.text);
  if (!m) return attrs;
  for (const a of m[1].matchAll(/#([\w-]+)|([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g)) {
    if (a[1]) attrs.id = a[1];
    else attrs[a[2]] = a[3] ?? a[4] ?? a[5];
  }
  last.text = last.text.slice(0, m.index);
  last.raw = last.raw.replace(/\s*\{[^{}]*\}\s*$/, '');
  token.text = token.text.replace(/\s*\{[^{}]*\}\s*$/, '');
  return attrs;
}

// Split a token list into groups. `isBreak(tok)` = "this token starts a new group";
// `dropBreak` = the break token itself is a separator (e.g. hr) and not kept.
function splitTokens(tokens, isBreak, dropBreak = false) {
  const groups = [];
  let cur = [];
  for (const t of tokens) {
    if (isBreak(t)) {
      if (cur.some((x) => x.type !== 'space')) groups.push(cur);
      cur = dropBreak ? [] : [t];
    } else cur.push(t);
  }
  if (cur.some((x) => x.type !== 'space')) groups.push(cur);
  return groups;
}

function renderCell(cell, { statusCol, tag }) {
  const text = cell.text.trim();
  let html = this.parser.parseInline(cell.tokens);
  const align = cell.align ? ` style="text-align:${cell.align}"` : '';
  if (tag === 'th') return `<th${align}>${html}</th>`;

  if (statusCol && text && !html.includes('class="status')) {
    const m = EXPLICIT_PREFIX.exec(text);
    let kind;
    if (m) {
      kind = m[1] ? STATUS_ALIASES[m[1].toLowerCase()] : STATUS_EMOJI[m[2]];
      html = html.replace(EXPLICIT_PREFIX, '');
    } else kind = inferStatus(text);
    return `<td${align}>${pill(kind, html)}</td>`;
  }
  const classes = [];
  if (/^(—|–|-|tbd|tba|n\/?a|none)$/i.test(text)) classes.push('muted');
  if (/^[~≈<>±]?\s*[-+]?[$€£¥]?\s*\d/.test(text)) classes.push('num');
  return `<td${classes.length ? ` class="${classes.join(' ')}"` : ''}${align}>${html}</td>`;
}

// `- [ ] Do the thing @Owner` lists become an action-item table.
function renderActions(items) {
  const rows = items.map((item, i) => {
    const [first, ...rest] = item.text.replace(/^\s*\[[ xX]\]\s*/, '').split('\n');
    let action = first.trim();
    let owners = [];
    const m = /((?:\s+@(?:\[[^\]]+\]|[\w.\-]+))+)\s*$/.exec(' ' + action);
    if (m) {
      action = (' ' + action).slice(0, m.index).trim();
      owners = [...m[1].matchAll(/@(?:\[([^\]]+)\]|([\w.\-]+))/g)].map((o) => o[1] ?? o[2].replace(/_/g, ' '));
    }
    const more = rest.join('\n').trim();
    const actionHtml = inline(action) + (more ? md.parse(more.replace(/^ {2,4}/gm, '')) : '');
    const owner = owners.length ? `<td>${owners.map(esc).join(', ')}</td>` : '<td class="muted">TBD</td>';
    const status = item.checked ? pill('good', 'Done') : pill('open', 'Open');
    return `<tr><td>${i + 1}</td><td>${actionHtml}</td>${owner}<td>${status}</td></tr>`;
  });
  return `<div class="table-wrap"><table class="actions">
<thead><tr><th>#</th><th>Action</th><th>Owner</th><th>Status</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table></div>\n`;
}

md.use({
  extensions: [
    // ==text==  → underlined emphasis
    {
      name: 'rule',
      level: 'inline',
      start: (src) => { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
        if (m) return { type: 'rule', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(t) { return `<span class="rule">${this.parser.parseInline(t.tokens)}</span>`; },
    },
    // {good: Label} → status pill anywhere inline
    {
      name: 'status',
      level: 'inline',
      start: (src) => src.match(new RegExp(`\\{(?:${STATUS_KEYS})\\s*:`, 'i'))?.index,
      tokenizer(src) {
        const m = new RegExp(`^\\{(${STATUS_KEYS})\\s*:\\s*([^}]+)\\}`, 'i').exec(src);
        if (m) return { type: 'status', raw: m[0], kind: STATUS_ALIASES[m[1].toLowerCase()], tokens: this.lexer.inlineTokens(m[2].trim()) };
      },
      renderer(t) { return pill(t.kind, this.parser.parseInline(t.tokens)); },
    },
    // ::: columns / ::: rows containers
    {
      name: 'container',
      level: 'block',
      start: (src) => src.match(/^:::/m)?.index,
      tokenizer(src) {
        const m = /^:::[ \t]*([\w-]+)[^\n]*\n([\s\S]*?)\n:::[ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'container', raw: m[0], kind: m[1].toLowerCase(), tokens: this.lexer.blockTokens(m[2], []) };
      },
      renderer(t) {
        const tokens = t.tokens;
        if (t.kind === 'columns' || t.kind === 'cols') {
          const hasHr = tokens.some((x) => x.type === 'hr');
          const firstDepth = tokens.find((x) => x.type === 'heading')?.depth;
          const cols = hasHr
            ? splitTokens(tokens, (x) => x.type === 'hr', true)
            : splitTokens(tokens, (x) => x.type === 'heading' && x.depth === firstDepth);
          const style = cols.length === 2 ? '' : ` style="--cols:${cols.length}"`;
          return `<div class="two-col"${style}>\n${cols.map((c) => `<div>\n${this.parser.parse(c)}</div>`).join('\n')}\n</div>\n`;
        }
        if (t.kind === 'rows' || t.kind === 'teams') {
          const depth = tokens.find((x) => x.type === 'heading')?.depth;
          const rows = splitTokens(tokens, (x) => x.type === 'heading' && x.depth === depth).map((r) => {
            const head = r[0].type === 'heading' ? r.shift() : null;
            return `<div class="team"><h4>${head ? this.parser.parseInline(head.tokens) : ''}</h4><div>${this.parser.parse(r)}</div></div>`;
          });
          return `<div class="teams">\n${rows.join('\n')}\n</div>\n`;
        }
        return `<div class="${esc(t.kind)}">\n${this.parser.parse(tokens)}</div>\n`;
      },
    },
  ],
  renderer: {
    heading(t) {
      const attrs = takeHeadingAttrs(t);
      const id = attrs.id ? ` id="${esc(attrs.id)}"` : '';
      return `<h${t.depth}${id}>${this.parser.parseInline(t.tokens)}</h${t.depth}>\n`;
    },

    table(t) {
      const heads = t.header.map((c) => c.text.trim());
      const statusIdx = heads.findIndex((h) => /^(status|state)$/i.test(h));
      const isActions = /^(#|no\.?)$/i.test(heads[0] ?? '');
      const th = t.header.map((c) => renderCell.call(this, c, { tag: 'th' })).join('');
      const rows = t.rows.map((row) => {
        const total = /^(total|sub-?total|grand total|sum)\b/i.test(row[0]?.text.trim() ?? '');
        const tds = row.map((c, i) => renderCell.call(this, c, { statusCol: i === statusIdx })).join('');
        return `<tr${total ? ' class="total"' : ''}>${tds}</tr>`;
      });
      return `<div class="table-wrap"><table${isActions ? ' class="actions"' : ''}>
<thead><tr>${th}</tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table></div>\n`;
    },

    blockquote(t) {
      let src = t.text;
      let tone = 'orange';
      let title = null;
      const alert = /^\[!([\w-]+)\][ \t]*(.*)(?:\n|$)/.exec(src);
      if (alert) {
        const kind = alert[1].toLowerCase();
        tone = CALLOUT_TONES[kind] ?? tone;
        title = humanise(kind) + (alert[2].trim() ? `: ${alert[2].trim()}` : '');
        src = src.slice(alert[0].length);
      } else {
        const bold = /^\*\*([^\n]+?)\*\*[ \t]*(?:\n|$)/.exec(src);
        if (bold) { title = bold[1]; src = src.slice(bold[0].length); }
      }
      const body = src.trim() ? `<div class="body">${this.parser.parse(md.lexer(src))}</div>` : '';
      const cls = tone === 'orange' ? 'callout' : `callout c-${tone}`;
      return `<div class="${cls}" role="note">
<span class="ic" aria-hidden="true"></span>
${title ? `<strong>${inline(title)}</strong>\n` : ''}${body}
</div>\n`;
    },

    list(t) {
      if (t.items.length && t.items.every((i) => i.task)) return renderActions(t.items);
      if (!t.ordered) return false;
      const start = t.start !== '' && t.start !== 1 ? ` start="${t.start}"` : '';
      return `<ol class="plain"${start}>\n${t.items.map((i) => this.listitem(i)).join('')}</ol>\n`;
    },
  },
});

// ---------------------------------------------------------------- document

const RESERVED = new Set([
  'title', 'org', 'kind', 'crumb', 'summary', 'lede', 'description', 'footer',
  'page_title', 'muted', 'toc', 'numbered', 'lang',
]);

function splitFrontmatter(src) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return [{}, src];
  const data = YAML.parse(m[1]) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter must be a YAML mapping');
  return [data, src.slice(m[0].length)];
}

function renderProps(fm) {
  const muted = new Set((fm.muted ?? ['absent', 'apologies']).map((k) => String(k).toLowerCase()));
  const rows = [];
  for (const [key, value] of Object.entries(fm)) {
    if (RESERVED.has(key) || value == null || value === '') continue;
    const label = humanise(key);
    let dd;
    if (Array.isArray(value)) {
      const out = muted.has(key.toLowerCase()) || muted.has(label.toLowerCase()) ? ' out' : '';
      dd = value.map((name) => `<span class="chip${out}"><i>${esc(initials(name))}</i>${esc(name)}</span>`).join('\n');
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      dd = Object.entries(value).map(([k, v]) => `${esc(humanise(k))}: ${inline(v)}`).join('<br>');
    } else if (typeof value === 'boolean') {
      dd = value ? 'Yes' : 'No';
    } else {
      dd = formatDate(value) ?? inline(value);
    }
    rows.push(`<dt>${esc(label)}</dt><dd>${dd}</dd>`);
  }
  return rows.length ? `<dl class="props">\n${rows.join('\n')}\n</dl>` : '';
}

export function render(source, { name = 'Minutes', css = '' } = {}) {
  const [fm, body] = splitFrontmatter(source);
  const tokens = md.lexer(body);
  const parser = () => new md.Parser(md.defaults);

  // Lift a leading `# Title` out of the body.
  let title = fm.title;
  const firstH2 = tokens.findIndex((t) => t.type === 'heading' && t.depth === 2);
  const preambleEnd = firstH2 < 0 ? tokens.length : firstH2;
  const h1 = tokens.slice(0, preambleEnd).findIndex((t) => t.type === 'heading' && t.depth === 1);
  let titleHtml;
  if (h1 >= 0) {
    const [tok] = tokens.splice(h1, 1);
    takeHeadingAttrs(tok);
    if (title == null) titleHtml = parser().parseInline(tok.tokens);
  }
  titleHtml ??= inline(title ?? name);
  const titleText = stripTags(titleHtml);

  // Preamble: first paragraph becomes the lede unless frontmatter supplies one.
  const sectionStart = tokens.findIndex((t) => t.type === 'heading' && t.depth === 2);
  const preamble = tokens.splice(0, sectionStart < 0 ? tokens.length : sectionStart);
  const ledeSrc = fm.summary ?? fm.lede ?? fm.description;
  let ledeHtml = ledeSrc != null ? inline(ledeSrc) : '';
  if (ledeSrc == null) {
    const i = preamble.findIndex((t) => t.type !== 'space');
    if (preamble[i]?.type === 'paragraph') ledeHtml = parser().parseInline(preamble.splice(i, 1)[0].tokens);
  }

  // Sections, one per `##`.
  const used = new Set();
  const numbered = fm.numbered !== false;
  const sections = splitTokens(tokens, (t) => t.type === 'heading' && t.depth === 2).map((group, i) => {
    const head = group.shift();
    const attrs = takeHeadingAttrs(head);
    const headHtml = parser().parseInline(head.tokens);
    let id = attrs.id ?? slugify(stripTags(headHtml));
    for (let n = 2; used.has(id); n++) id = `${attrs.id ?? slugify(stripTags(headHtml))}-${n}`;
    used.add(id);
    return { id, n: i + 1, headHtml, tocHtml: attrs.toc ? esc(attrs.toc) : headHtml, bodyHtml: parser().parse(group) };
  });

  const dateText = fm.date != null ? (formatDate(fm.date) ?? String(fm.date)) : null;
  const kind = fm.kind ?? 'Meeting minutes';
  const crumb = fm.crumb != null ? [].concat(fm.crumb) : [fm.org, kind].filter(Boolean);
  const footer = fm.footer === false ? null : (fm.footer ?? [fm.org, kind, dateText].filter(Boolean).join(' · '));
  const pageTitle = fm.page_title ?? [titleText, fm.org].filter(Boolean).join(' — ');
  const showToc = fm.toc !== false && sections.length >= 2;
  const num = (s) => (numbered ? `<span class="n">${s.n}</span>` : '');

  const preambleHtml = preamble.some((t) => t.type !== 'space')
    ? `\n    <section class="intro">\n${parser().parse(preamble)}    </section>\n` : '';

  return `<!DOCTYPE html>
<html lang="${esc(fm.lang ?? 'en')}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(pageTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Inter+Tight:wght@500;600&display=swap" rel="stylesheet">
<style>
${css}
</style>
</head>
<body>
<div class="layout${showToc ? '' : ' no-toc'}">
${showToc ? `  <nav class="toc" aria-label="Contents">
    <p>Contents</p>
    <ol>
${sections.map((s) => `      <li><a href="#${esc(s.id)}">${numbered ? `<span>${s.n}</span>` : ''}${s.tocHtml}</a></li>`).join('\n')}
    </ol>
  </nav>
` : ''}
  <main>
    <header class="doc">
${crumb.length ? `      <p class="crumb">${crumb.map((c) => inline(c)).join(' <span class="sep">/</span> ')}</p>\n` : ''}      <h1>${titleHtml}</h1>
${ledeHtml ? `      <p class="lede">${ledeHtml}</p>\n` : ''}      ${renderProps(fm)}
    </header>
${preambleHtml}
${sections.map((s) => `    <section id="${esc(s.id)}">
      <h2>${num(s)}${s.headHtml}</h2>
${s.bodyHtml}    </section>`).join('\n\n')}
${footer ? `\n    <footer>${inline(footer)}</footer>` : ''}
  </main>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage: minutes <notes.md> [more.md ...] [options]

Options:
  -o, --out <path>   Output file (single input), directory (multiple inputs), or "-" for stdout.
                     Default: next to each input, with a .html extension.
  -w, --watch        Rebuild whenever an input (or style.css) changes.
  -h, --help         Show this help.
`;

async function build(input, out) {
  const [src, css] = await Promise.all([readFile(input, 'utf8'), readFile(STYLE_PATH, 'utf8')]);
  const html = render(src, { name: basename(input, extname(input)), css });
  if (out === '-') process.stdout.write(html);
  else {
    await writeFile(out, html);
    console.error(`✓ ${input} → ${out}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      watch: { type: 'boolean', short: 'w' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stderr.write(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const outFor = (input) => {
    const html = basename(input, extname(input)) + '.html';
    if (!values.out) return join(dirname(input), html);
    if (values.out === '-' || positionals.length === 1) return values.out;
    return join(values.out, html);
  };

  const run = async (input) => {
    try { await build(input, outFor(input)); }
    catch (e) { console.error(`✗ ${input}: ${e.message}`); if (!values.watch) process.exitCode = 1; }
  };
  for (const input of positionals) await run(input);

  if (values.watch) {
    const timers = new Map();
    const schedule = (inputs) => {
      for (const input of inputs) {
        clearTimeout(timers.get(input));
        timers.set(input, setTimeout(() => run(input), 60));
      }
    };
    for (const input of positionals) watch(resolve(input), () => schedule([input]));
    watch(STYLE_PATH, () => schedule(positionals));
    console.error('Watching for changes… (Ctrl-C to stop)');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
