import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { Turn } from '@wilco/voice-core'
import { findOpenable } from './editor.ts'
import { type Hit, rowHit, sameTarget, shift, type Target } from './hits.ts'
import { type LayoutPrefs, resolveLayout } from './layout.ts'
import {
  type AgentPane,
  type AppState,
  glyph,
  isAction,
  laneShown,
  matchActions,
  projects,
  tasksOf,
} from './model.ts'
import { drawPanel } from './panel-view.ts'
import { PLAIN, type Skin } from './skin.ts'
import type { SpendView } from './spend.ts'
import { blank, box, type Drawn, fit, overlay, type Pointer, Row, stack } from './ui.ts'

// Drawing, as one pure function of state.
//
// The window is shaped like the thing it is showing. Projects are tabs along
// the top, because you are in one at a time. The tasks of that project are down
// the side with what they have changed under them, the middle is the agent you
// are watching, and the orchestrator runs along the bottom, always there and
// not closeable — it is how you know what Wilco heard. Money is bottom right,
// what needs you and the key to talk with are top right, and a panel, when one
// is open, floats over all of it.
//
// Composition is done here rather than with a layout engine because the panes
// have to tail: an agent's newest output is the point, and a stack that clips
// from the bottom would show you the top of the screen instead.

export type { Drawn } from './ui.ts'

/** A file the task has changed, as git sees it. */
export interface Change {
  path: string
  /** `M`odified, `A`dded, `D`eleted, `R`enamed, `?` untracked, `U`nmerged. */
  mark: string
  added: number | null
  removed: number | null
}

export interface Frame {
  width: number
  height: number
  /** The focused lane's screen, as captured. May carry ANSI. */
  screen: string
  /** The orchestrator's own screen, when it is running where you can see it. */
  orchestrator?: string
  /** Top of the focused task's worktree. */
  files?: readonly string[]
  /** What the focused task has changed since it branched. */
  changes?: readonly Change[]
  /** The branch those changes are counted against. */
  base?: string | null
  /** What you have told Wilco about this project, newest first. */
  notes?: readonly string[]
  /** Today's spend, in total and by task. */
  spend?: Spend
  /** What the agent you are looking at runs on, as configured. */
  route?: { harness: string; model: string | null; provider: string | null }
  /** What it says it actually runs on, and how full its context is. */
  vitals?: { model: string | null; contextPercent: number | null } | null
  /** The Spend panel's view, when it is open. */
  spendView?: SpendView | null
  /** The key you hold to talk, and whether there is anything to hear you. */
  voice?: { keys: readonly string[]; available: boolean }
  /** Wilco's home, as you would type it, for showing where worktrees go. */
  home?: string
  now?: number
  /** How to divide the window. Defaults when absent. */
  layout?: LayoutPrefs
  /** How to colour it. Plain unless told otherwise. */
  skin?: Skin
}

export interface Spend {
  tokens: number
  usd: number
  hasCost: boolean
  byTask: Readonly<Record<string, { tokens: number; usd: number }>>
}

/**
 * The buttons along the foot, which are also what clicking them does. Each
 * names an action the app carries out; none of them types a command for you.
 */
export const BUTTONS: readonly { label: string; action: string; look?: 'primary' }[] = [
  { label: '+ New task', action: 'new-task' },
  { label: 'Open project', action: 'open-project' },
  { label: 'Settings', action: 'settings' },
]

/** The whole window, one string per row, each exactly as wide as the window. */
export function renderApp(state: AppState, frame: Frame): string[] {
  return draw(state, frame).rows
}

export function draw(state: AppState, frame: Frame): Drawn {
  const skin = frame.skin ?? PLAIN
  const pointer: Pointer = { hover: state.hover, pressed: state.pressed }
  const { sidebarWidth, stripHeight, mainWidth, bodyHeight } = resolveLayout(
    frame.layout ?? {},
    frame,
  )
  // The clamped width, not the asked-for one: a terminal too narrow to hold a
  // readable sidebar and a pane still gets whole rows, just wider than itself.
  const width = sidebarWidth + mainWidth + 1

  const rows: string[] = []
  const hits: Hit[] = []
  const add = (drawn: Drawn) => {
    hits.push(...shift(drawn.hits, rows.length))
    rows.push(...drawn.rows)
  }

  add(renderTop(state, frame, width, skin, pointer))

  const left = renderSidebar(state, frame, sidebarWidth, bodyHeight, skin, pointer)
  const right = renderMain(state, frame, mainWidth, bodyHeight, skin, pointer)
  const body: Drawn = { rows: [], hits: [...left.hits, ...shift(right.hits, 0, sidebarWidth + 1)] }
  for (let i = 0; i < bodyHeight; i++) {
    body.rows.push(
      `${fit(left.rows[i] ?? '', sidebarWidth)}${skin.chrome('│')}${fit(right.rows[i] ?? '', mainWidth)}`,
    )
  }
  add(body)

  add(renderStrip(state, frame, width, stripHeight, skin))
  add(renderFoot(state, frame, width, skin, pointer))

  const window: Drawn = { rows, hits }
  if (!state.panel) return window
  const panel = drawPanel(state.panel, {
    width,
    height: rows.length,
    skin,
    pointer,
    home: frame.home ?? '~/.wilco',
    route: frame.route ?? null,
    spend: frame.spendView ?? null,
    panes: state.panes,
    project: state.project,
  })
  const panelWidth = Math.max(0, ...panel.rows.map((row) => visibleWidth(row)))
  const at = {
    row: Math.max(1, Math.floor((rows.length - panel.rows.length) / 3)),
    col: Math.max(0, Math.floor((width - panelWidth) / 2)),
  }
  return overlay(window, panel, at, width, skin, true)
}

// ── Top: projects, what needs you, and the key to talk ───────────────────────

function renderTop(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const row = new Row(width, skin, pointer).space().text('WILCO', skin.brand).space(2)
  for (const project of projects(state)) {
    row.tab(project, { kind: 'project', project }, project === state.project)
  }
  row.text(' + ', skin.signal, { kind: 'action', name: 'open-project' })

  row.right((r) => {
    const waiting = state.panes.filter((pane) => pane.waiting || pane.state === 'blocked').length
    const working = state.panes.filter((pane) => pane.state === 'working').length
    // The talk key is the one thing here that must survive a narrow terminal,
    // so the counts shorten, and then go, before it does.
    const roomy = width >= 110
    if (waiting > 0) {
      const label = roomy ? `● ${waiting} waiting` : `● ${waiting}`
      r.text(label, skin.waiting, { kind: 'action', name: 'next-waiting' }).space(2)
    }
    if (working > 0 && roomy) r.text(`○ ${working} working`, skin.busy).space(3)
    talkChip(r, state, frame, skin)
    r.space()
  })
  return stack([row.build(), { text: skin.chrome('━'.repeat(width)), hits: [] }])
}

/**
 * The key you talk with, always on screen, in whatever state talking is in.
 * Red while the microphone is open: that is never something to have to infer.
 */
function talkChip(r: Row, state: AppState, frame: Frame, skin: Skin): void {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const target: Target = { kind: 'action', name: 'voice' }
  if (state.talkingSince !== null && state.listening) {
    const seconds = Math.max(
      0,
      Math.floor(((frame.now ?? state.talkingSince) - state.talkingSince) / 1000),
    )
    r.text(` ● TX ${clock(seconds)} `, skin.transmit, target)
    return
  }
  if (state.hearing) {
    r.text('◌ hearing you…', skin.hint, target)
    return
  }
  r.keys(voice.keys).space()
  r.text(voice.available ? 'talk' : 'type', skin.hint, target)
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// ── Side: agents, changes, files, notes ──────────────────────────────────────

interface Section {
  id: string
  label: string
  count: number | null
  /** Rows when unfolded. At least one, so an open section never looks broken. */
  rows: (row: () => Row) => { text: string; hits: Hit[] }[]
  action?: { label: string; target: Target }
  /** Said quietly at the right of the heading: what the section is measured against. */
  note?: string
}

function renderSidebar(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const tasks = tasksOf(state)
  const changes = frame.changes ?? []
  const notes = frame.notes ?? []
  const files = frame.files ?? []
  const spend = frame.spend?.byTask ?? {}

  const sections: Section[] = [
    {
      id: 'agents',
      label: 'AGENTS',
      count: tasks.length,
      action: { label: '+', target: { kind: 'action', name: 'new-task' } },
      rows: (row) =>
        tasks.length === 0
          ? [row().space(3).text('none yet — + starts one', skin.hint).build()]
          : tasks.map((task) => taskRow(row(), task, spend[task.task], skin)),
    },
    {
      id: 'changes',
      label: 'CHANGES',
      count: changes.length,
      ...(frame.base ? { note: `vs ${frame.base.replace(/^origin\//, '')}` } : {}),
      rows: (row) =>
        changes.length === 0
          ? [
              row()
                .space(3)
                .text(state.focused ? 'nothing changed' : '—', skin.hint)
                .build(),
            ]
          : changes.map((change) => changeRow(row(), change, skin)),
    },
    {
      id: 'files',
      label: 'FILES',
      count: null,
      rows: (row) =>
        files.length === 0
          ? [row().space(3).text('—', skin.hint).build()]
          : files.map((path) =>
              row()
                .space(3)
                .text(path, path.endsWith('/') ? skin.busy : (t) => t, { kind: 'file', path })
                .build(),
            ),
    },
    {
      id: 'notes',
      label: 'NOTES',
      count: notes.length,
      rows: (row) =>
        notes.length === 0
          ? [row().space(3).text('nothing noted yet', skin.hint).build()]
          : notes.map((text) => row().space(3).text(text, skin.hint).build()),
    },
  ]

  const out: { text: string; hits: Hit[] }[] = []
  const make = () => new Row(width, skin, pointer)
  let previousOpen = false
  sections.forEach((section, i) => {
    if (out.length >= height) return
    if (i > 0 && previousOpen) out.push(blank(width))
    const open = !state.folded.includes(section.id)
    previousOpen = open
    const head = make()
      .space()
      .text(`${open ? '▾' : '▸'} ${section.label}`, skin.label, {
        kind: 'section',
        section: section.id,
      })
    if (section.count !== null && section.count > 0) head.space().badge(section.count)
    if (section.action) {
      const action = section.action
      head.right((r) => r.text(` ${action.label} `, skin.signal, action.target))
    } else if (section.note) {
      const note = section.note
      head.right((r) => r.text(note, skin.hint).space())
    }
    out.push(head.build())
    if (open) out.push(...section.rows(make))
  })
  return stack(out.slice(0, height))
}

function taskRow(
  row: Row,
  task: AgentPane & { focused: boolean },
  spent: { tokens: number; usd: number } | undefined,
  skin: Skin,
): { text: string; hits: Hit[] } {
  const target: Target = { kind: 'task', task: task.task }
  const hover = row.pointer.hover
  const hovered = hover !== null && 'task' in hover && hover.task === task.task
  row.text(task.focused ? '▌' : ' ', skin.signal, target)
  row.text(glyph(task), toneOf(task, skin), target).space()
  row.text(task.name, task.focused ? skin.you : (t) => t, target)
  row.right((r) => {
    if (spent && (spent.usd > 0 || spent.tokens > 0)) {
      r.text(spent.usd > 0 ? dollars(spent.usd) : tokens(spent.tokens), skin.hint, target).space()
    }
    // The menu mark, and its click, only where it is drawn: on the task you
    // are on, or the one under the pointer. An invisible button is a trap.
    if (task.focused || hovered) {
      r.text('≡', skin.signal, { kind: 'task-menu', task: task.task }).space()
    } else {
      r.space(2)
    }
  })
  const built = row.build()
  // The whole row is the task; the menu mark sits on top of it.
  const hits = [rowHit(0, row.width, target), ...built.hits]
  return { text: task.focused ? skin.selected(built.text) : built.text, hits }
}

function changeRow(row: Row, change: Change, skin: Skin): { text: string; hits: Hit[] } {
  const mark =
    change.mark === 'A' || change.mark === '?'
      ? skin.done
      : change.mark === 'D' || change.mark === 'U'
        ? skin.bad
        : skin.waiting
  const target: Target = { kind: 'file', path: change.path }
  const counts = [
    change.added ? `+${change.added}` : '',
    change.removed ? `−${change.removed}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const room = row.width - 5 - (counts ? counts.length + 2 : 0)
  row
    .space(2)
    .text(change.mark, mark, target)
    .space()
    .text(shortPath(change.path, room), (t) => t, target)
  row.right((r) => {
    if (change.added) r.text(`+${change.added}`, skin.done)
    if (change.added && change.removed) r.space()
    if (change.removed) r.text(`−${change.removed}`, skin.bad)
    r.space()
  })
  return row.build()
}

/** `src/payments/webhooks.test.ts` → `…/webhooks.test.ts`: the name is the part you know. */
export function shortPath(path: string, room: number): string {
  if (path.length <= room) return path
  const name = path.split('/').at(-1) ?? path
  const short = `…/${name}`
  return short.length <= room ? short : `…${name.slice(-Math.max(1, room - 1))}`
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  if (pane.waiting || pane.state === 'blocked') return skin.waiting
  if (pane.state === 'failed') return skin.bad
  if (pane.state === 'review') return skin.done
  if (pane.state === 'working') return skin.busy
  return skin.hint
}

// ── Middle: the agent you are watching ───────────────────────────────────────

function renderMain(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const pane = state.panes.find((p) => p.task === state.focused)
  if (!pane) return renderWelcome(state, frame, width, height, skin, pointer)

  const shown = laneShown(state, pane)
  const header = new Row(width, skin, pointer)
    .space()
    .text(`${pane.project} › ${pane.name}`, skin.you)
    .space(2)
  // A tab per lane — the agent, and any shell beside it — and + for another.
  if (pane.lanes.length === 0) header.tab('agent', { kind: 'task', task: pane.task }, true)
  laneLabels(pane.lanes).forEach(({ id, label }) => {
    header.tab(label, { kind: 'lane', task: pane.task, lane: id }, id === shown)
  })
  header.text(' + ', skin.signal, { kind: 'action', name: 'new-shell' })
  const route = frame.route
  const vitals = frame.vitals
  if (route || vitals) {
    header.right((r) => {
      // What the agent says it runs on beats what the config hoped for.
      const model = vitals?.model ?? route?.model
      r.text(
        `${route?.harness ?? 'pi'} · ${model ? shortModel(model) : 'its default model'}`,
        skin.hint,
      )
      if (vitals?.contextPercent !== null && vitals?.contextPercent !== undefined) {
        const percent = vitals.contextPercent
        const tone = percent >= 85 ? skin.bad : percent >= 60 ? skin.waiting : skin.busy
        r.text(' · ctx ', skin.hint)
          .meter(percent / 100, 8, tone)
          .text(` ${Math.round(percent)}%`, skin.hint)
      }
      r.space()
    })
  }

  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
  ]
  const room = height - rows.length
  if (room <= 0) return stack(rows.slice(0, height))

  if (!shown) {
    rows.push(blank(width))
    rows.push(
      new Row(width, skin)
        .space(2)
        .text(`${describeState(pane)}.`, skin.hint)
        .build(),
    )
    rows.push(blank(width))
    rows.push(
      new Row(width, skin, pointer)
        .space(2)
        .button('Open its agent', { kind: 'action', name: 'open-agent' }, 'primary')
        .space()
        .text('picks the conversation up where it stopped', skin.hint)
        .build(),
    )
  } else {
    const lines = frame.screen.split('\n')
    for (const line of lines.slice(-room)) rows.push(screenRow(line, width, skin, pointer))
  }

  while (rows.length < height) rows.push(blank(width))
  const drawn = stack(rows.slice(0, height))
  if (pane.approval) return withApproval(drawn, pane.approval, width, height, skin, pointer)
  return drawn
}

/**
 * One row of an agent's screen, with its links and file references made
 * clickable. The one under the pointer is underlined, which costs that row its
 * own colours while you point at it — a fair trade for seeing what you would
 * open.
 */
function screenRow(
  line: string,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] } {
  const plain = stripTerminalSequences(line)
  const hits: Hit[] = []
  let text = fit(line, width)
  for (const found of findOpenable(plain)) {
    if (found.from >= width) continue
    const target: Target =
      found.target.kind === 'url'
        ? { kind: 'link', url: found.target.url }
        : {
            kind: 'place',
            path: found.target.path,
            ...(found.target.line ? { line: found.target.line } : {}),
            ...(found.target.column ? { column: found.target.column } : {}),
          }
    const to = Math.min(found.to, width - 1)
    hits.push({ row: 0, from: found.from, to, target })
    if (sameTarget(pointer.hover, target)) {
      const cells = [...fit(plain, width)]
      text =
        cells.slice(0, found.from).join('') +
        skin.link(cells.slice(found.from, to + 1).join('')) +
        cells.slice(to + 1).join('')
    }
  }
  return { text, hits }
}

/** A waiting approval, where the agent asked for it, answerable by click. */
function withApproval(
  pane: Drawn,
  approval: { tool: string; summary: string },
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const cardWidth = Math.min(width - 4, 64)
  if (cardWidth < 30) return pane
  const inner = cardWidth - 2
  const card = box(
    'wants approval',
    [
      new Row(inner, skin)
        .space()
        .text(approval.tool, skin.you)
        .space(2)
        .text(approval.summary)
        .build(),
      new Row(inner, skin, pointer)
        .space()
        .button('Allow once', { kind: 'action', name: 'approve' }, 'attention')
        .space()
        .button('Deny', { kind: 'action', name: 'deny' })
        .build(),
    ],
    cardWidth,
    skin,
    { tone: skin.chrome, title: skin.waiting, surface: false },
  )
  // Not modal: the agent's screen stays readable around it.
  return overlay(
    pane,
    card,
    { row: Math.max(2, height - card.rows.length - 1), col: 2 },
    width,
    skin,
    false,
  )
}

function renderWelcome(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const project = state.project
  const rows = [
    blank(width),
    new Row(width, skin)
      .space(3)
      .text(project ? `Nothing is running in ${project}.` : 'No projects yet.', skin.you)
      .build(),
    blank(width),
    new Row(width, skin, pointer)
      .space(3)
      .button('+ New task', { kind: 'action', name: 'new-task' }, project ? 'primary' : 'off')
      .space()
      .button(
        'Open project',
        { kind: 'action', name: 'open-project' },
        project ? 'rest' : 'primary',
      )
      .build(),
    blank(width),
    new Row(width, skin)
      .space(3)
      .text('Or hold ', skin.hint)
      .keys(voice.keys)
      .text(' and say what you want done.', skin.hint)
      .build(),
  ]
  return stack(rows.slice(0, height))
}

function describeState(pane: AgentPane): string {
  switch (pane.state) {
    case 'review':
      return 'Ready for review, and no agent is running'
    case 'parked':
      return 'Parked'
    case 'failed':
      return 'Its last run failed'
    default:
      return 'No agent is running here'
  }
}

// ── Bottom: the orchestrator, the buttons, and what it costs ─────────────────

function renderStrip(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
): Drawn {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  let bar: string
  const talking = state.listening && state.talkingSince !== null
  if (talking) {
    const seconds = Math.max(0, Math.floor(((frame.now ?? 0) - (state.talkingSince ?? 0)) / 1000))
    const left = new Row(width, skin)
      .text('━ ', skin.chrome)
      .text(' ● TX ', skin.transmit)
      .space()
      .text('listening', skin.you)
      .space()
      .text(clock(seconds), skin.hint)
      .space()
    const tail = ' release to send · esc cancels ━'
    left.text('━'.repeat(Math.max(0, width - left.used - tail.length)), skin.chrome)
    left.text(tail, skin.chrome)
    bar = left.build().text
  } else {
    const label = `━ orchestrator${state.focused === null ? ' ── here' : ''} `
    bar = skin.chrome(label + '━'.repeat(Math.max(0, width - label.length)))
  }

  const rows = [fit(bar, width)]
  const hits: Hit[] = [rowHit(0, width, { kind: 'orchestrator' })]
  const room = height - 1

  if (frame.orchestrator !== undefined && !isAction(state.dictation)) {
    for (const line of frame.orchestrator.split('\n').slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(fit(line, width))
    }
    while (rows.length < height) rows.push(' '.repeat(width))
    return { rows: rows.slice(0, height), hits }
  }

  if (talking) {
    // What the microphone hears, as it hears it — only where the recorder can
    // tell. A meter that moves on its own would be a lie about the one thing
    // you need to trust while talking.
    const meter = state.levels.length > 0 ? levelMeter(state.levels, Math.min(width - 6, 48)) : null
    const lines = [
      ' '.repeat(width),
      meter ? `   ${skin.busy(meter.heard)}${skin.chrome(meter.rest)}` : ' '.repeat(width),
      ' '.repeat(width),
      `${skin.transmit(' ◉ ')} ${skin.hint('speak — Wilco hears you until you let go')}`,
    ]
    for (let gap = room - lines.length; gap > 0; gap--) rows.push(' '.repeat(width))
    for (const line of lines.slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(fit(line, width))
    }
    return { rows: rows.slice(0, height), hits }
  }

  const body: string[] = []
  if (state.question) {
    body.push(skin.waiting(` ? ${state.question.question}`))
    body.push(skin.hint(`   ${state.question.candidates.join('  ·  ')}`))
  }
  for (const turn of state.turns) body.push(...renderTurn(turn, width, skin))
  if (state.notice) body.push(skin.hint(` · ${state.notice}`))

  if (isAction(state.dictation)) {
    const found = matchActions(state, state.dictation ?? '')
    for (const action of found.slice(0, Math.max(1, height - 2))) {
      const line = ` ${action.name.padEnd(10)} ${action.about}`
      body.push(action.ready ? line : skin.hint(line))
    }
    if (found.length === 0) body.push(skin.hint('  no command like that'))
  }

  // The line you type on, always last. `◉` while the microphone is open, `›`
  // while you type: the same line, and which one it is matters.
  const prompt = new Row(width, skin).space()
  if (state.dictation !== null) {
    prompt
      .text(state.listening ? '◉' : '›', state.listening ? skin.bad : skin.signal)
      .space()
      .text(`${state.dictation}▏`, skin.you)
  } else if (state.held) {
    prompt.text(`◌ ${state.held}▏`, skin.hint)
  } else {
    prompt.text('›', skin.hint).space()
    prompt.right((r) => r.text('type, or hold ', skin.hint).keys(voice.keys).space())
  }

  const shown = body.slice(-(room - 1))
  for (let gap = room - 1 - shown.length; gap > 0; gap--) rows.push(' '.repeat(width))
  for (const line of shown) {
    hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
    rows.push(fit(line, width))
  }
  hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
  rows.push(prompt.build().text)
  return { rows: rows.slice(0, height), hits }
}

function renderFoot(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const row = new Row(width, skin, pointer).space()
  for (const button of BUTTONS) {
    const look = button.action === 'new-task' && !state.project ? 'off' : (button.look ?? 'rest')
    row.button(button.label, { kind: 'action', name: button.action }, look).space()
  }
  const route = frame.route
  const spend = frame.spend
  const target: Target = { kind: 'action', name: 'spend' }
  row.right((r) => {
    const model = frame.vitals?.model ?? route?.model
    r.text(model ? shortModel(model) : 'its default model', skin.hint, target)
    if (route?.provider) r.text(` · ${route.provider}`, skin.hint, target)
    if (spend && spend.tokens > 0) {
      r.text(' │ ', skin.chrome, target).text(tokens(spend.tokens), skin.hint, target)
      if (spend.hasCost)
        r.text(' │ ', skin.chrome, target).text(dollars(spend.usd), skin.you, target)
    }
    r.text(' today ▾', skin.hint, target).space()
  })
  return stack([{ text: skin.chrome('─'.repeat(width)), hits: [] }, row.build()])
}

/**
 * One exchange: what was heard, where it went and why, then the answer. The
 * reasoning is shown so a wrong guess is obvious and can be corrected.
 */
export function renderTurn(turn: Turn, width: number, skin: Skin = PLAIN): string[] {
  const lines = [skin.you(fit(` ❯ ${turn.utterance}`, width).trimEnd())]
  const parts: string[] = [turn.intent]
  if (turn.task) parts.push(turn.task)
  if (turn.why) parts.push(`"${turn.why}"`)
  lines.push(skin.hint(fit(`   → ${parts.join(' · ')}`, width).trimEnd()))
  if (turn.reply) lines.push(fit(`   ${turn.reply}`, width).trimEnd())
  return lines
}

/**
 * Recent loudness as a row of bars, newest on the right, padded on the left
 * with the floor so the meter keeps its width from the first moment.
 */
export function levelMeter(
  levels: readonly number[],
  cells: number,
): { heard: string; rest: string } {
  const bars = '▁▂▃▄▅▆▇█'
  const recent = levels.slice(-cells)
  const heard = recent
    .map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))])
    .join('')
  return { heard, rest: '▁'.repeat(Math.max(0, cells - recent.length)) }
}

/** Tab names for a task's lanes: `agent`, `shell`, `shell 2`. */
export function laneLabels(
  lanes: readonly { id: string; kind: string }[],
): { id: string; label: string }[] {
  const seen = new Map<string, number>()
  return lanes.map((lane) => {
    const n = (seen.get(lane.kind) ?? 0) + 1
    seen.set(lane.kind, n)
    return { id: lane.id, label: n === 1 ? lane.kind : `${lane.kind} ${n}` }
  })
}

// ── Numbers, the way people read them ────────────────────────────────────────

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k tok`
  return `${count} tok`
}

export function dollars(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

/** `anthropic/claude-opus-5` reads as `claude-opus-5`: the provider is said separately. */
function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model
}
