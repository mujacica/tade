// The workflows, folded for drawing: where each one stands, how the whole
// divides, the shape its steps make, the line of its versions, the runs that
// were stamped from it, and the words a field is drawn with — in numbers and
// words, and nothing that touches the DOM, so the offline suite runs every one
// of them (`test/workflows-client.test.ts`).
//
// **Nothing here decides anything about a workflow.** Whether a draft would
// publish is `templateProblems`' answer, carried as `problems`; the shape is
// `workflowPlaces`' (`places`); whether a field may be saved is `savingOf`'s;
// and a run's state is its steps' marks (`stepMark`). Every fold here starts
// from one of those answers and only counts, orders or picks among them.

import { flowGeometry } from '../charts.js'
import { joined, stepMark } from '../glyphs.js'

/* ── where a workflow stands ───────────────────────────────────────────────── */

/**
 * The ways a workflow can stand, loudest first: a draft that would not
 * publish, a draft open, published with nothing open, one Tade ships, and an
 * empty name with neither.
 *
 * `tone` is a chart's word (`charts.js`' `TONES`) and `text` the class a glyph
 * of it wears, so the bar, its legend and a card's mark never disagree about
 * what a colour means. **Only two of them carry a colour that says something**:
 * red for a draft somebody has to fix before it can go anywhere, and amber for
 * a draft that is work in progress. Published is green because it is finished
 * and ready to be run; the rest are the grey ladder. `always` ones stay in the
 * legend at nought — *nothing would fail to publish* is a fact.
 */
export const STANDINGS = [
  {
    key: 'broken',
    label: 'won’t publish',
    tone: 'failed',
    text: 't-failed',
    glyph: '▲',
    always: true,
  },
  {
    key: 'draft',
    label: 'draft open',
    tone: 'working',
    text: 't-working',
    glyph: '◐',
    always: true,
  },
  {
    key: 'published',
    label: 'published',
    tone: 'done',
    text: 't-done',
    glyph: '✓',
    always: true,
  },
  {
    key: 'shipped',
    label: 'ships with Tade',
    tone: 'quiet',
    text: 't-quiet',
    glyph: '⌗',
    always: false,
  },
  {
    key: 'empty',
    label: 'nothing written',
    tone: 'queued',
    text: 't-quiet',
    glyph: '○',
    always: false,
  },
]

/**
 * Which of `STANDINGS` one workflow is in.
 *
 * One Tade ships is that whatever else is true of it, because nothing about
 * it can be changed by anybody here. A problem is loudest after that: a draft
 * that would not publish is the one thing on this page somebody has to do
 * something about.
 */
export function standingOf(row) {
  if (row.builtIn) return 'shipped'
  if (row.problems.length > 0) return 'broken'
  if (row.draft !== null) return 'draft'
  if (row.published !== null) return 'published'
  return 'empty'
}

/** A standing's mark, as `glyphs.js` shapes one. */
export function standingMark(key) {
  const one = STANDINGS.find((each) => each.key === key) ?? STANDINGS[4]
  return { glyph: one.glyph, word: one.label, tone: one.text }
}

/** How the workflows divide, as a stack's parts, in the order they should read. */
export function partsOf(rows) {
  const counts = new Map(STANDINGS.map((one) => [one.key, 0]))
  for (const row of rows) {
    const key = standingOf(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return STANDINGS.filter((one) => one.always || (counts.get(one.key) ?? 0) > 0).map((one) => ({
    key: one.key,
    label: one.label,
    tone: one.tone,
    n: counts.get(one.key) ?? 0,
  }))
}

/* ── the groups on the list ────────────────────────────────────────────────── */

/**
 * The list's groups, in the order a person wants them: what is open (the one
 * thing a device may write to), then what is published, then what Tade ships.
 * A heading is read in sentence case, so none of them names Tade: it would
 * come out *tade*.
 */
export const GROUPS = [
  { key: 'drafts', heading: 'DRAFTS' },
  { key: 'published', heading: 'PUBLISHED' },
  { key: 'shipped', heading: 'BUILT IN' },
]

const GROUP_OF = {
  broken: 'drafts',
  draft: 'drafts',
  empty: 'drafts',
  published: 'published',
  shipped: 'shipped',
}

const LOUDNESS = new Map(STANDINGS.map((one, at) => [one.key, at]))

/**
 * The workflows by group, each group loudest first and then by name — so the
 * draft that would not publish is the first card on the page.
 */
export function groupsOf(rows) {
  return GROUPS.map((group) => ({
    ...group,
    rows: rows
      .filter((row) => GROUP_OF[standingOf(row)] === group.key)
      .sort(
        (a, b) =>
          (LOUDNESS.get(standingOf(a)) ?? 0) - (LOUDNESS.get(standingOf(b)) ?? 0) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      ),
  }))
}

/* ── the runs stamped from one ─────────────────────────────────────────────── */

/**
 * Where a run stamped from a workflow stands, in the words a card has room
 * for. **The loudest of its steps' own marks**, which is a choice among
 * answers `deriveState` and the journal already gave, never a rule of its
 * own. A run with no step this device may read says *that*, never finished.
 */
export const RUN_MARKS = {
  wants: { glyph: '◆', word: 'wants you', tone: 't-wants' },
  failed: { glyph: '▲', word: 'a step failed', tone: 't-failed' },
  working: { glyph: '●', word: 'under way', tone: 't-working' },
  review: { glyph: '✓', word: 'in review', tone: 't-done' },
  waiting: { glyph: '○', word: 'waiting', tone: 't-quiet' },
  finished: { glyph: '✓', word: 'finished', tone: 't-done' },
  unseen: { glyph: '◌', word: 'not readable here', tone: 't-quiet' },
}

const RUN_ORDER = Object.keys(RUN_MARKS)

/** Which of `RUN_MARKS` one run wears. */
export function runStandingOf(run) {
  if (run.steps.length === 0) return 'unseen'
  const words = new Set(run.steps.map((step) => stepMark(step).word))
  if (words.has('blocked')) return 'wants'
  if (words.has('failed')) return 'failed'
  if (words.has('working')) return 'working'
  if (run.total > 0 && run.finished === run.total) return 'finished'
  if (words.has('review') || words.has('merged')) return 'review'
  return 'waiting'
}

/** The runs this device can see that were stamped from one workflow, loudest first. */
export function runsFrom(row, runs) {
  return runs
    .filter((run) => run.stamp !== null && run.stamp !== undefined && run.stamp.name === row.name)
    .sort(
      (a, b) =>
        RUN_ORDER.indexOf(runStandingOf(a)) - RUN_ORDER.indexOf(runStandingOf(b)) ||
        b.stamp.version - a.stamp.version ||
        (a.run < b.run ? -1 : a.run > b.run ? 1 : 0),
    )
}

/**
 * The runs from one workflow, counted by where they stand.
 *
 * **`row.runs` is the machine's count and the one to believe**; the runs this
 * device can see are the ones in projects it may read. What the two differ by
 * is said as *not readable here* rather than dropped, so a phone granted one
 * project never says a workflow that ran ten times ran twice.
 */
export function runsLineOf(row, runs) {
  const seen = runsFrom(row, runs)
  const total = Math.max(row.runs, seen.length)
  const counts = new Map()
  for (const run of seen) {
    const key = runStandingOf(run)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const unseen = total - seen.length
  if (unseen > 0) counts.set('unseen', (counts.get('unseen') ?? 0) + unseen)
  return {
    total,
    parts: RUN_ORDER.filter((key) => (counts.get(key) ?? 0) > 0).map((key) => ({
      key,
      ...RUN_MARKS[key],
      n: counts.get(key) ?? 0,
    })),
  }
}

/** The runs line in one sentence, for a screen reader and the offline suite. */
export function runsSaid(line) {
  if (line.total === 0) return 'never run'
  const runs = `${line.total} ${line.total === 1 ? 'run' : 'runs'}`
  return `${runs}: ${joined(line.parts.map((one) => `${one.n} ${one.word}`))}`
}

/* ── the whole page, at a glance ───────────────────────────────────────────── */

/** What the lead says: how many, how they divide, and what was run from them. */
export function overallOf(rows, runs) {
  const stamped = rows.flatMap((row) => runsFrom(row, runs))
  return {
    workflows: rows.length,
    parts: partsOf(rows),
    runs: rows.reduce((sum, row) => sum + row.runs, 0),
    going: stamped.filter((run) =>
      ['wants', 'failed', 'working', 'waiting', 'review'].includes(runStandingOf(run)),
    ).length,
    problems: rows.reduce((sum, row) => sum + row.problems.length, 0),
  }
}

/* ── the line of its versions ──────────────────────────────────────────────── */

/** How many published versions a line draws before it says how many came earlier. */
export const MOST_VERSIONS = 6

/**
 * Its versions, oldest to newest, then the draft — each with the runs this
 * device can see that point at it.
 *
 * **A published version and the draft are two kinds of mark**, always: one is
 * a snapshot a run can point at for ever, the other a file nothing runs. The
 * newest published is its own kind, because it is what a run started now
 * would be stamped from. Past `MOST_VERSIONS` the oldest are a count, said.
 */
export function versionsOf(row, runs = []) {
  const counts = new Map()
  for (const run of runsFrom(row, runs)) {
    counts.set(run.stamp.version, (counts.get(run.stamp.version) ?? 0) + 1)
  }
  const published = [...row.versions].sort((a, b) => a - b)
  const shown = published.slice(-MOST_VERSIONS)
  const marks = shown.map((version) => ({
    key: `v${version}`,
    label: `v${version}`,
    kind: version === row.published ? 'newest' : 'published',
    runs: counts.get(version) ?? 0,
  }))
  if (row.draft !== null) {
    marks.push({ key: 'draft', label: `v${row.draft}`, kind: 'draft', runs: 0 })
  }
  return { marks, earlier: published.length - shown.length }
}

/** The line of versions in one sentence: what is published, what is open, what ran. */
export function versionsSaid(row, runs = []) {
  const published = [...row.versions].sort((a, b) => a - b)
  const bits = []
  if (published.length === 0) bits.push('never published')
  else if (published.length > 3) {
    bits.push(`published v${published[0]} to v${published.at(-1)}`)
  } else bits.push(`published ${joined(published.map((one) => `v${one}`))}`)
  bits.push(row.draft === null ? 'no draft open' : `draft v${row.draft} open`)
  const ran = versionsOf(row, runs).marks.filter((one) => one.runs > 0)
  for (const one of ran) {
    bits.push(`${one.runs} ${one.runs === 1 ? 'run' : 'runs'} on ${one.label}`)
  }
  return bits.join('; ')
}

/* ── the shape its steps make ──────────────────────────────────────────────── */

/** The map's spacing in its own units: a column per stage, a row per step in it. */
export const MAP = { dx: 36, dy: 20, r: 5, pad: 8 }

const round = (n) => Math.round(n * 100) / 100

/**
 * The shape as a small map: a column per stage, a dot per step, and a curve
 * from each step to what waits on it — the picture a card has room for, with
 * the names written beside it.
 *
 * **A step in a cycle is named, never drawn**: a cycle has no column,
 * `templateProblems` is what refuses it, and a dot drawn at some column would
 * read as an order the workflow does not have.
 */
export function shapeOf(places) {
  const drawn = places.filter((place) => !place.circular)
  const depths = [...new Set(drawn.map((place) => place.depth))].sort((a, b) => a - b)
  const columns = depths.map((depth) =>
    drawn.filter((place) => place.depth === depth).sort((a, b) => a.at - b.at),
  )
  const tallest = Math.max(1, ...columns.map((column) => column.length))
  const where = new Map()
  columns.forEach((column, x) => {
    column.forEach((place, y) => {
      where.set(place.name, {
        x: round(MAP.pad + x * MAP.dx),
        y: round(MAP.pad + ((tallest - column.length) / 2 + y) * MAP.dy),
      })
    })
  })
  const dots = drawn.map((place) => ({ name: place.name, ...where.get(place.name) }))
  const lines = []
  for (const place of drawn) {
    const to = where.get(place.name)
    for (const wait of place.why) {
      const from = where.get(wait.on)
      if (from === undefined || to === undefined) continue
      const mid = round((from.x + to.x) / 2)
      lines.push({
        from: wait.on,
        to: place.name,
        d: `M${from.x} ${from.y}C${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}`,
      })
    }
  }
  const empty = depths.length === 0
  return {
    dots,
    lines,
    width: empty ? 0 : round(MAP.pad * 2 + (depths.length - 1) * MAP.dx),
    height: empty ? 0 : round(MAP.pad * 2 + (tallest - 1) * MAP.dy),
    stages: depths.length,
    circular: places.filter((place) => place.circular).map((place) => place.name),
  }
}

/** The shape in words: how many steps, in how many stages, and any in a cycle. */
export function shapeSaid(places) {
  const shape = shapeOf(places)
  const steps = shape.dots.length
  const bits = []
  if (steps === 0 && shape.circular.length === 0) return 'no steps yet'
  if (steps > 0) {
    const noun = `${steps} ${steps === 1 ? 'step' : 'steps'}`
    bits.push(
      shape.stages <= 1 && steps > 1
        ? `${noun}, side by side`
        : steps === 1
          ? noun
          : `${noun} in ${shape.stages} stages`,
    )
  }
  if (shape.circular.length > 0) bits.push(`${shape.circular.length} in a cycle`)
  return bits.join(' · ')
}

/**
 * The steps, stage by stage: what goes first, and what each later stage waits
 * on — the shape the rail on one workflow's screen draws, and the lines a
 * card writes beside its map.
 *
 * `steps` carries each step's own row where this device was sent it (the
 * content rides on the `workflows` grant; the places do not), so a stage can
 * always be named even where a step cannot be described.
 */
export function stagesOf(row) {
  const byName = new Map(row.steps.map((step) => [step.name, step]))
  const drawn = row.places.filter((place) => !place.circular)
  const depths = [...new Set(drawn.map((place) => place.depth))].sort((a, b) => a - b)
  const stages = depths.map((depth, at) => {
    const here = drawn.filter((place) => place.depth === depth).sort((a, b) => a.at - b.at)
    const on = [...new Set(here.flatMap((place) => place.why.map((wait) => wait.on)))]
    return {
      key: `stage-${depth}`,
      n: at + 1,
      label: on.length === 0 ? 'goes first' : `after ${joined(on)}`,
      steps: here.map((place) => ({
        name: place.name,
        step: byName.get(place.name) ?? null,
        waits: place.why,
      })),
    }
  })
  const circular = row.places.filter((place) => place.circular).sort((a, b) => a.at - b.at)
  if (circular.length > 0) {
    stages.push({
      key: 'cycle',
      n: null,
      label: 'in a cycle: each waits, directly or not, on itself',
      steps: circular.map((place) => ({
        name: place.name,
        step: byName.get(place.name) ?? null,
        waits: place.why,
      })),
    })
  }
  return stages
}

/**
 * The shape as `flowIn` takes a graph: a box per step, numbered by its stage,
 * with what it is told by under its name, and an edge per wait.
 */
export function graphOf(row) {
  const byName = new Map(row.steps.map((step) => [step.name, step]))
  const drawn = row.places.filter((place) => !place.circular)
  const depths = [...new Set(drawn.map((place) => place.depth))].sort((a, b) => a - b)
  return {
    nodes: drawn
      .sort((a, b) => a.at - b.at)
      .map((place) => {
        const step = byName.get(place.name)
        return {
          id: place.name,
          label: place.name,
          under: step === undefined ? '' : (step.persona ?? step.model ?? ''),
          tone: null,
          glyph: String(depths.indexOf(place.depth) + 1),
          href: null,
        }
      }),
    edges: drawn.flatMap((place) =>
      place.why.map((wait) => ({ from: wait.on, to: place.name, tone: null })),
    ),
  }
}

/**
 * Whether the boxes fit across the room they are given. **A graph is drawn
 * across or not at all**: where it would not fit, the stages under it are
 * already the same graph drawn down, so a second, taller drawing would only
 * say it twice.
 */
export function fitsAcross(graph, room) {
  if (graph.nodes.length < 2 || !(room > 0)) return false
  return flowGeometry(graph.nodes, graph.edges, 'right').width <= room
}

/* ── how it would publish ──────────────────────────────────────────────────── */

/**
 * Whether its draft would publish, in a mark and a line — the one sentence
 * the top of its screen says about it.
 */
export function readinessOf(row) {
  if (row.builtIn) {
    return {
      glyph: '⌗',
      tone: 't-quiet',
      said: 'Ships with Tade: its bytes are in Tade’s own source',
    }
  }
  if (row.problems.length > 0) {
    const n = row.problems.length
    return {
      glyph: '▲',
      tone: 't-failed',
      said: `${n} ${n === 1 ? 'thing' : 'things'} would stop this draft publishing`,
    }
  }
  if (row.draft === null) {
    return row.published === null
      ? { glyph: '○', tone: 't-quiet', said: 'Nothing written yet: no draft and nothing published' }
      : {
          glyph: '✓',
          tone: 't-done',
          said: `No draft open: v${row.published} is what a run is stamped from`,
        }
  }
  const warned = row.warnings.length
  return {
    glyph: '✓',
    tone: 't-done',
    said:
      warned === 0
        ? `Draft v${row.draft} would publish as it stands`
        : `Draft v${row.draft} would publish, with ${warned} ${warned === 1 ? 'warning' : 'warnings'}`,
  }
}

/* ── a step's facts ────────────────────────────────────────────────────────── */

/** What `leaves` means, in the words a step's facts are read in. */
const LEAVES = {
  green: 'green',
  red: 'red, on purpose',
}

/**
 * A step's facts, as names and values: only the ones it has, so a step with
 * no rule of its own is not a column of dashes. `mono` where the value is
 * text that is also a path or a model somewhere else.
 */
export function stepFactsOf(step) {
  const reads = step.fields.find((field) => field.id === 'reads')?.value?.words ?? ''
  return [
    { label: 'finished when', value: step.done, mono: false },
    { label: 'leaves the checks', value: LEAVES[step.leaves] ?? step.leaves, mono: false },
    { label: 'produces', value: step.produces, mono: true },
    { label: 'touches', value: step.touches.join(' ') || null, mono: true },
    { label: 'reads', value: reads === '' ? null : reads, mono: true },
  ].filter((one) => one.value !== null && one.value !== undefined && one.value !== '')
}

/* ── a field of the form ───────────────────────────────────────────────────── */

/**
 * A field's label, as a person reads it. The window indents the reason under
 * a wait (`  why it waits`), which says what it is about only by where it
 * sits; here it says so in words.
 */
export function fieldLabel(field) {
  if (field.id.startsWith('why:')) return `Why it waits on ${field.id.slice('why:'.length)}`
  return field.label.trim()
}

/** What a field holds, in words: a dash where nothing was sent, `none` where it is empty. */
export function fieldSaid(field) {
  if (field.value === null || field.value === undefined) return '—'
  if (field.kind === 'check') return field.value.words === 'true' ? 'yes' : 'no'
  return field.value.words === '' ? 'none' : field.value.words
}

/**
 * Which control a field is edited with.
 *
 * A tick is **a press that says what it will do**, never a checkbox and a
 * save: saving a wait flips it on the machine whatever value is sent, so a
 * box somebody left alone and saved would flip it the other way. Prose — what
 * a step is told, what a workflow is about, why a step waits — gets room to
 * be read while it is written.
 */
export function editorOf(field) {
  if (field.kind === 'check') return 'toggle'
  if (field.kind === 'choice') return 'choice'
  if (field.id === 'prompt' || field.id === 'about' || field.id.startsWith('why:')) return 'long'
  return 'text'
}

/** A choice's options, with the one it holds always among them and `''` said as none. */
export function choicesOf(field) {
  const held = field.value?.words ?? ''
  const all = field.options.includes(held) ? field.options : [held, ...field.options]
  return all.map((one) => ({ value: one, said: one === '' ? 'none' : one }))
}

/**
 * What a box starts with: what the field holds now — **unless only the start
 * of it was sent**, because a box holding a cut value is a save that throws
 * the rest away. Then it starts empty and `cutOf` says why.
 */
export function prefillOf(field) {
  if (field.value === null || field.value === undefined || field.value.more) return ''
  return field.value.words
}

export function cutOf(field) {
  return field.value?.more === true
    ? 'Only the start of this was sent here: what you type replaces all of it'
    : ''
}

/** What a tick's press says it will do, which is the whole of what it does. */
export function toggleSaid(field) {
  const on = field.id.startsWith('after:') ? field.id.slice('after:'.length) : fieldLabel(field)
  return field.value?.words === 'true' ? `Stop waiting on ${on}` : `Wait on ${on}`
}

/** What a tick's press sends: the other answer, which is what saving one does. */
export function toggledValue(field) {
  return field.value?.words === 'true' ? 'false' : 'true'
}

/**
 * What a box holds after a fill, pure — the rule that keeps somebody's words.
 *
 * `box` is `{ value, was, saved, focused }`: what is in it, what it was last
 * filled with, the draft revision it was saved at (null when nothing is
 * waiting to be read back), and whether the keyboard is in it. `now` is what
 * the field holds now, `rev` the draft revision the row is of.
 *
 * - **A box nobody has typed in follows the draft** (`value === was`), unless
 *   the keyboard is in it — a value changing under a caret is a sentence
 *   rewritten while somebody reads it.
 * - **A box somebody typed in is theirs**, whatever arrives, until they save
 *   or put it back.
 * - **A saved box keeps what was saved until the draft moves**: a beat that
 *   lands before the machine has read the draft again still carries the old
 *   value, and putting that back would look like the save undoing itself.
 */
export function boxAfter(box, now, rev) {
  if (box.saved !== null) {
    if (box.saved === (rev ?? '')) return box
  }
  const untouched = box.was === null || box.value === box.was
  return {
    value: untouched && !box.focused ? now : box.value,
    was: untouched ? now : box.was,
    saved: null,
    focused: box.focused,
  }
}

/** Whether a box says something the field does not hold: drawn as *not saved*. */
export function boxDirty(box) {
  return box.value !== (box.was ?? '')
}

/**
 * Whether what a step is told is long enough to fold. A line or two is read
 * whole: a `more` under a sentence that has no more is a press that does
 * nothing a person can see.
 */
export function foldsAt(said) {
  if (said === null || said === undefined) return false
  return said.more === true || said.words.length > 240 || said.words.split('\n').length > 3
}

/** A region's state, with the page's own mark (`ui.js`' `stateBoxIn`). */
export function stateOf(kind, title, line) {
  return { kind, icon: 'workflows', title, line }
}
