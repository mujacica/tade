# Designing a page of Tade Away

Read this before drawing or redrawing a page in `packages/web/src/assets/`. It is the design
language every page speaks, so thirteen pages redesigned by thirteen people still read as one
product. The arithmetic behind it is held by `test/design.test.ts`, `test/components.test.ts`,
`test/charts.test.ts` and `test/pages.test.ts`; the rest is held by you, and by the browser
harness (`scripts/browser.ts`, see `SKILL.md`).

## What is yours, and what is shared

**A page is its own files**, and you own exactly those:

| Page | View(s) | Files |
|---|---|---|
| overview | `now` | `pages/overview.js`, `pages/overview.css` |
| project | `project` | `pages/project.js`, `pages/project.css` |
| agent | `task` | `pages/agent.js`, `pages/agent-pane.js`, `pages/agent-time.js`, `pages/agent-shape.js`, `pages/agent.css` |
| inbox | `inbox`, `request` | `pages/inbox.js`, `pages/inbox.css` |
| plans (`/plans`; the views and files kept the wire's word, *run*) | `runs`, `run` | `pages/runs.js`, `pages/runs-*.js`, `pages/runs.css` |
| workflows | `workflows`, `workflow` | `pages/workflows.js`, `pages/workflows.css` |
| checks, reviews, findings, spend, notes, devices, settings, queue, more | the same name | `pages/<page>.js`, `pages/<page>.css` |

A page may split itself into `pages/<page>-<part>.js` helpers (`agent-pane.js` is one). It may not
import another page, and nothing shared imports a page but `boot.js`. **Every rule in
`pages/<page>.css` must name `.page-<page>` or a class only that page's modules draw** — the router
puts `page-<page>` on the screen's root (`PAGE_OF` in `routes.js`). To restyle a shared component on
your page only, scope it: `.page-checks .ui-stat { … }`. Page sheets are linked last, so a page's rule
beats a shared one of the same specificity without `!important` (which is refused).

**Everything else is shared and not yours to edit**: `tokens.css`, `ui.css`/`ui.js`,
`charts.css`/`charts.js`, `frame.css`, `page.css`, `away.css`, `dash.css`, `dock.css`, `rows.js`,
`dom.js`, `glance.js`, `controls.js`, `quick.js`, `figures.js`, `glyphs.js`, `store.js`, the routes
and the tests that hold them.

**Needing a shared component you do not have** is normal. Build what you need inside your own files
first (scoped to your page), and in your **final message** list it under *Shared components wanted*:
its name, what it draws, the create/fill signature you used, and which file of yours has the working
version — somebody lifts it into the library once, for every page. Never edit a shared file to get
it, and never copy one shared look into your sheet with a different name.

## A page, top to bottom

1. **The bar** (`section(TITLE, { top: true })` or `pageBar`): the name, the crumb back, how many,
   and at its end what may be done here (`tools`). Never a second `h1`.
2. **The lead: the answer at a glance, drawn.** What somebody opening this page wants to know,
   graphically and first — a row of stats with their trends, a gauge, a donut, a flow. What wants the
   person comes before anything that is merely true.
3. **The detail, grouped**: sections headed as the menu heads its categories (`section('GROUP')`),
   each a panel of rows, ranked bars, lanes, or names and values. Detail is behind the lead, never
   instead of it.
4. **Every region in one of four states**: coming, nothing, unknown, wrong (below). A region is
   never blank.

On a phone it is the same order in one column. At a desk, two columns only when both are full —
`grid-template-columns: minmax(0, 1fr) 20rem` with `align-items: start`, and the narrow one holds
what is short (facts, controls). A column that runs three times longer than its neighbour is a page
that should have been one column, or whose long part belongs in the lead.

## Rhythm: spacing and alignment

The 4px grid (`--s1` 4 … `--s7` 48) spent through four names (`tokens.css`):

| Token | Is | Use |
|---|---|---|
| `--gutter` | 16px phone, 24px from 768 | the work's edge to anything in it; a full-width line runs out by it and back in by it |
| `--inset` | 16px | inside a card or panel, all four sides (a dense row: `--s3` block, `--inset` inline) |
| `--stack` | 24px | between groups on a page, and under the bar |
| `--s3` | 12px | between things inside a group: tiles in a row, a chart and its legend |
| `--bar` | 52px phone, 48px desk | a line of the frame: header, page bar, the side's heading, a strip |
| `--tap` | 44px thumb, 32px mouse | every control's minimum height and width |

The rules that make a page look designed rather than placed:

- **A control is never as tall as the line it sits in.** A press in a bar is `--tap` inside a
  `--bar`, so it has room above and below and never touches the hairlines. A card holding a press
  pads it by `--inset`. This is the squeezed button the person pointed at; `--bar` exists to end it.
- **Centred, or aligned on purpose, never left where it fell.** A state, a gauge, a donut's figure
  and a lone press are centred in their room. Everything else starts on the gutter's line: labels
  left, figures right, and numbers in a column are `tabular-nums` and `text-align: end`.
- **No dead space.** Grids are `repeat(auto-fit, minmax(min(100%, Nrem), 1fr))` so the last row
  fills; flex rows that end in a press push it with `margin-inline-start: auto` only when the line
  has a name at the other end. A tile in a row is the same height as its neighbours (the grid does
  it) and puts its trend at its foot.
- **One baseline per row.** Tiles in a row share label, figure and line positions because they are
  the same component; do not build a fifth tile by hand.

## Type

The system face (`--font-ui`), mono only for what is also text in the window — a branch, a sha, a
path, a model. Sizes are steps, never pixels, and never under 13px:

| Step | Size | For |
|---|---|---|
| `--step--1` | 13 | labels, units, timestamps, legends, a chart's words |
| `--step-0` | 15 | body, rows, the bar's title |
| `--step-1` | 17 | a row's primary line, a state's title, every input (iOS does not zoom) |
| `--step-2` | 22 | a gauge's or donut's figure |
| `--step-3` | 28 | a stat's figure |
| `--step-4` | 40 | the one hero number a page may have |

Weights are tokens, never numbers: `--w-body` 400 reading text, `--w-label` 500 a label or a unit,
`--w-strong` 600 a name, a heading, a press, a figure, `--w-loud` 700 a badge that must be seen. A
page has **one** thing at `--step-3` or above per region; if two things shout, neither is heard.
Big figures take `letter-spacing: var(--tight)`. Uppercase only in a section heading (the heading
reads itself in sentence case to a screen reader).

## Colour: what each one means

Two colours and three that only inform (`tokens.css`). **A colour says one thing, and is never the
only thing saying it** — every state also has a glyph and a word (`glyphs.js`).

| Tone | Colour | Means | Use it for |
|---|---|---|---|
| `wants` | violet | waiting on you | the one colour that means *act*: approvals, questions, proposals |
| `working`, `here` | amber | Tade, in progress, where you are | running agents, the primary press, the focus ring, *now* |
| `done` | green | finished, green | checks passing, merged, done steps |
| `failed` | red | wrong, or about to be | red checks, a plan window nearly out, an error |
| `queued`, `quiet` | greys | waiting its turn, not important now | queued work, parked, the rest |
| `unknown` | hatched grey | nobody could read it | never drawn as nought |

**Highlight what wants the person; mute what does not.** A page full of colour has no emphasis:
most of it is the grey ladder, and colour appears where something needs a decision or has gone
wrong. Text stays in text greys (`--bright` names and values, `--body` second lines, `--heading`
labels); a mark beside it carries the tone. **A category is not a state**: projects, models and
harnesses are told apart by their **labels** (ranked bars, one tone), never by a sixth hue —
`design.test.ts` refuses one.

## Elevation

Depth is a ladder of lighter greys and a hairline, never a shadow: `--ground` the page → `--panel`
a card, panel or tile → `--surface` a row under the pointer, where you are → `--raised` a field,
anything above a card → `--chosen` the row you are on. `--lift` is the one shadow, for what floats
(the command bar, a sheet, a toast). Radii: `--r2` cards, `--r1` controls, `--r3` tags; only dots
and rings are round.

## The components: which for what

Composed, never rewritten. Each is a **create** that builds once and a **fill** that patches on
every delta (twice a second — a fill must not rebuild what has focus). From `charts.js` unless
marked `ui.js`.

| Job | Component | Notes |
|---|---|---|
| a headline number, and how it moved | `stats(label)` holding `stat(label, href)` → `statIn(node, { value, unit, under, tone, trend, delta })` | `value: null` draws `—`; `trend` is numbers with `null` gaps; tone the figure only when it is a state |
| a trend beside a number | `spark()` → `sparkIn(node, values, tone)` | decoration; the number is in words beside it |
| how full: a plan window, a budget | `gauge(label)` → `gaugeIn(node, { share, said, under, pressure })` | `pressure` `fine`/`warm`/`tight` from `planPressure` |
| how a whole divides (states of the work) | `stack(label)` → `stackIn(node, [{ key, label, n, tone }])` | carries its legend; parts of nought stay in the legend |
| how a whole stands, at a glance | `donut(label)` → `donutIn(node, parts, { said, under })`; `.is-small` beside a row | `role="img"` with every part in its sentence |
| comparing named things (spend by project) | `bars(label)` → `barsIn(node, [{ key, label, value, said, href, under }])` | one tone; `value: null` draws no bar and says why |
| what happened over time, per thing | `lanes(label)` → `lanesIn(node, { from, to, now, ticks, lanes })` | spans and marks; a span with no end runs to `now` |
| what waits on what | `flow(label)` → `flowIn(node, { nodes, edges }, 'right' \| 'down')` | `down` on a phone; scrolls in its own region when wide |
| a run of moments (checks per run, commits per day) | `heat(label)` → `heatIn(node, cells, { rows, said, tone })` | a cell is a `tone` or a `level` (`levelsOf`); `rows: 7` is a calendar |
| how far along | `steps(label)` → `stepsIn(node, [{ label, state, under }])` | turns into a column when narrow |
| facts in a line (an agent's) | `facts(label)` → `factsIn(node, cells)` (`ui.js`) | a dash where unknown, never a missing cell |
| rows of things | `panel('ul', 'rows')` with `rows.js`'s create/fill pairs and `keyed` | the three columns: glyph, name, figure |
| what went wrong after a press | `problem()`/`answerIn` (`ui.js`), words from `trouble.js` | |
| a word, a tag, a count, a chip | `.ui-pill`, `count`/`countIn`, `.ui-chip` (`ui.js`/`ui.css`) | a count is empty at nought |

A chart is never the only statement of a figure: either it is `role="img"` with a sentence the fill
writes, or it is real text (a legend, a label, a value) with the marks `aria-hidden` over it.

## Every region's four states

- **Coming**: before the first snapshot, `skeleton(n)` the shape of the rows that are coming, or
  `stateBox()` → `stateBoxIn(node, { kind: 'loading', title })` (`ui.js`) where the region is a chart.
- **Nothing**: `stateBoxIn(node, { kind: 'empty', title, line })` — centred, what is not there and
  what would put something there. A short list's nothing may be `empty(said)`.
- **Unknown**: `—` and **which** unknown (`unknown(word)`): not run here, not recorded, could not
  look. Never nought, never `$0.00`.
- **Wrong**: `stateBoxIn(node, { kind: 'error', title, line, action })` for a region, `problem()`
  for a press; the words are `trouble.js`'s, never a body's own text.

And two nulls are two sentences: *none* and *not granted to this device* (`nothingSaid`, `mayFor`).

## Before you say a page is done

- 360px, 834px and 1440px: nothing sideways but a table or a flow in its own `.scrolls` region;
  every control at least `--tap`; the lead visible without scrolling on a phone.
- `pnpm vitest run packages/web`, and the browser harness green (axe, landmarks, targets,
  sideways) — see `SKILL.md` for how to run it; look at its `--shots` for your page.
- The README's pictures are the window's; redraw them only if you changed the window.
- Your final message lists any *Shared components wanted*.
