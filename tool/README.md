# minutes

Turns a Markdown file (with optional YAML frontmatter) into a self-contained meeting-minutes page, styled like the [HOTO minutes](https://jimmy-lew.github.io/minutes/techd/220926.html).

```sh
cd tool && pnpm install
pnpm build                                     # every .md in the repo → .html, plus folder indexes
pnpm watch                                     # same, rebuilding on save
node minutes.mjs ../techd/221026.md            # a single file
node minutes.mjs notes.md -o out.html          # explicit output (-o - for stdout)
```

Pushing to `main` runs [`.github/workflows/build.yml`](../.github/workflows/build.yml), which builds every Markdown file and deploys the HTML to GitHub Pages. Each folder also gets an `index.html` listing its meetings newest first (by frontmatter `date`, or a `DDMMYY` file name), and the root `index.html` lists the folders. Built `.html` files are gitignored, so only commit the `.md` sources. [`techd/220926.md`](../techd/220926.md) shows most of the syntax.

## Frontmatter

All keys are optional.

```yaml
---
title: Handover & takeover              # or use a leading "# Title" in the body
org: NUSC Tech Directorate              # breadcrumb, <title>, footer
summary: One-line description.          # or the first paragraph before the first "##"
date: 2026-09-22                        # ISO dates render as "22 September 2026"
Outgoing: [Yihao, Andrew]               # any list → row of name chips
Incoming: [Bryan Wong, Kenneth, Jimmy]
Minutes by: Jimmy                       # any other value → plain text row
muted: [Outgoing]                       # dim these chip rows (default: Absent, Apologies)
---
```

Apart from `title`, `org`, `summary`, `muted` and the keys in the table below, every key (including `date`) becomes a row in the header, in the order you wrote it. Labels are humanised, so `minutes_by` becomes "Minutes by".

| Key | Effect |
| --- | --- |
| `kind` | Second breadcrumb item and footer text (default "Meeting minutes") |
| `crumb` | Override the breadcrumb (string or list) |
| `footer` | Override the footer text; `false` hides it |
| `page_title` | Override the browser tab title |
| `toc: false` | Hide the contents sidebar (it is hidden anyway with fewer than 2 sections) |
| `numbered: false` | Drop the section numbers |
| `lang` | `<html lang>` (default `en`) |

## Body

Each `##` heading starts a numbered section with an entry in the sidebar.

```md
## Current infrastructure {#infra toc="Infrastructure"}
```

The `{…}` part is optional. It sets the anchor id and a shorter sidebar label.

| Write | Get |
| --- | --- |
| Any table | Bordered table; first column emphasised, `$`/number cells tabular, `—` / `TBD` / `n/a` cells muted |
| A row starting with `Total` | Total row with a top rule |
| A column headed `Status` | Coloured status dots, guessed from the words ("done", "in progress", "blocked", "outdated"…). Force one with a `{good}` `{warn}` `{low}` `{bad}` `{open}` prefix, or 🟢 🟡 🟣 🔴 ⚪ |
| `{warn: At risk}` anywhere | Inline status dot |
| `==text==` | Underlined emphasis (the "Don't just say yes." style) |
| `> [!blocker] Title` + lines | Callout. `blocker`/`warning`/`risk` orange, `note`/`info` violet, `decision`/`tip` green, `question` yellow, `danger` red. A plain `> **Title**` quote works too |
| `- [ ] Do X @Owner` | Action-items table (#, Action, Owner, Status). `[x]` = Done, no owner = TBD, multi-word owners as `@[Bryan Wong]` or `@Bryan_Wong` |
| `1. …` ordered list | Muted-number list (Open questions style) |
| `::: columns` … `:::` | Side-by-side columns, split at each heading (or at `---`) |
| `::: rows` … `:::` | Labelled rows (the "Team notes" block), one per `####` heading |

Styles live in [`style.css`](style.css) and are inlined into each page, so the output is a single HTML file.
