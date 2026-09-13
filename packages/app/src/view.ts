import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Turn } from '@wilco/voice-core'
import { type Chip, chips, type Hit, rowHit } from './hits.ts'
import { type LayoutPrefs, resolveLayout } from './layout.ts'
import {
  type AgentPane,
  type AppState,
  glyph,
  headline,
  isAction,
  matchActions,
  paneTitle,
  projects,
  tasksOf,
} from './model.ts'
import { PLAIN, type Skin } from './skin.ts'

// Drawing, as one pure function of state.
//
// The window is shaped like the thing it is showing. Projects are tabs along
// the top, because you are in one at a time. The tasks of that project are
// tabs down the side, because the same is true of them. The middle is the
// agent you are watching, the files under the task list say which worktree
// that is, and the orchestrator runs along the bottom, always there and not
// closeable — it is how you know what Wilco heard.
//
// Composition is done here rather than with a layout engine because the panes
// have to tail: an agent's newest output is the point, and a stack that clips
// from the bottom would show you the top of the screen instead.

export interface Frame {
  width: number
  height: number
  /** The focused lane's screen, as captured. May carry ANSI. */
  screen: string
  /** The orchestrator's own screen, when it is running where you can see it. */
  orchestrator?: string
  /** Files in the focused task's worktree, for the list under the tasks. */
  files?: readonly string[]
  /** How to divide the window. Defaults when absent. */
  layout?: LayoutPrefs
  /** How to colour it. Plain unless told otherwise. */
  skin?: Skin
}

/** The window, and what each part of it is, from one pass over the layout. */
export interface Drawn {
  rows: string[]
  hits: Hit[]
}

/**
 * What the footer offers, which is also what clicking it does.
 *
 * Each one is a command line, so a button is exactly a thing you could have
 * typed: the ones ending in a space put a half-written line in front of you to
 * finish, and the rest just happen.
 */
export const BUTTONS: readonly { label: string; does: string }[] = [
  { label: 'new task', does: '/task ' },
  { label: 'agent', does: '/agent ' },
  { label: 'open', does: '/open ' },
  { label: 'settings', does: '/settings' },
  { label: 'help', does: '/help' },
  { label: 'quit', does: '/quit' },
]

/** The whole window, one string per row, each exactly as wide as the window. */
export function renderApp(state: AppState, frame: Frame): string[] {
  return draw(state, frame).rows
}

export function draw(state: AppState, frame: Frame): Drawn {
  const skin = frame.skin ?? PLAIN
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
    for (const hit of drawn.hits) hits.push({ ...hit, row: hit.row + rows.length })
    for (const row of drawn.rows) rows.push(row)
  }

  add(renderTabs(state, width, skin))

  // The two lists down the side share the column: the tasks take what they
  // need, the files take what is left. Both are the same worktree, seen from
  // two directions.
  const tasks = tasksOf(state)
  const taskRows = Math.min(Math.max(3, tasks.length + 2), Math.max(3, Math.ceil(bodyHeight / 2)))
  const left = renderTasks(tasks, sidebarWidth, taskRows, skin)
  const files = renderFiles(frame.files ?? [], sidebarWidth, bodyHeight - left.rows.length, skin)
  const right = renderMain(state, frame.screen, mainWidth, bodyHeight, skin)

  const column = [...left.rows, ...files.rows]
  const columnHits = [
    ...left.hits,
    ...files.hits.map((hit) => ({ ...hit, row: hit.row + left.rows.length })),
  ]
  add({
    rows: Array.from({ length: bodyHeight }, (_, i) =>
      [pad(column[i] ?? '', sidebarWidth), skin.chrome('│'), pad(right[i] ?? '', mainWidth)].join(
        '',
      ),
    ),
    hits: columnHits,
  })

  add(renderStrip(state, frame, width, stripHeight, skin))

  const bar = chips(1, buttonChips(), width, (label) => skin.tab(label))
  add({ rows: [skin.chrome('─'.repeat(width)), pad(bar.text, width)], hits: bar.hits })
  return { rows, hits }
}

function buttonChips(): Chip[] {
  return BUTTONS.map((button) => ({
    label: button.label,
    target: { kind: 'action', name: button.does } as const,
  }))
}

/**
 * The projects, along the top, with the one you are in picked out.
 *
 * A tab per project and a `+` that starts a task in the one you are on: the
 * two things you do at this level of the window, where you can see them.
 */
function renderTabs(state: AppState, width: number, skin: Skin): Drawn {
  const mark = ' WILCO '
  const names = projects(state)
  const tabs: Chip[] = names.map((project) => ({
    label: project,
    target: { kind: 'project', project } as const,
  }))
  tabs.push({ label: '+', target: { kind: 'action', name: '/task ' } })

  const room = Math.max(0, width - mark.length)
  const bar = chips(0, tabs, room, (label, item) =>
    item.target.kind === 'project' && item.target.project === state.project
      ? skin.here(label)
      : skin.tab(label),
  )
  const news = headline(state)
  const left = `${skin.brand(mark)}${bar.text}`
  const spare = width - mark.length - bar.width - visibleWidth(news) - 1
  const row = spare > 0 ? `${left}${' '.repeat(spare)}${skin.you(news)} ` : left

  return {
    rows: [
      pad(row, width),
      // A heavy rule under the tabs: it is the lid of the window, and the one
      // line that says where the chrome stops and the work starts.
      skin.chrome('━'.repeat(width)),
    ],
    hits: bar.hits.map((hit) => ({
      ...hit,
      from: hit.from + mark.length,
      to: hit.to + mark.length,
    })),
  }
}

/** The tasks of the project you are in, as tabs down the side. */
function renderTasks(
  tasks: readonly (AgentPane & { focused: boolean })[],
  width: number,
  height: number,
  skin: Skin,
): Drawn {
  const rows = [skin.label(clip(' AGENTS', width))]
  const hits: Hit[] = []
  for (const task of tasks) {
    const line = clip(`${task.focused ? '▌' : ' '} ${glyph(task)} ${task.name}`, width)
    hits.push(rowHit(rows.length, width, { kind: 'task', task: task.task }))
    rows.push(task.focused ? skin.here(pad(line, width)) : paintGlyph(line, task, skin))
    if (rows.length >= height) break
  }
  if (tasks.length === 0) rows.push(skin.hint(clip('  none yet — + adds one', width)))
  return { rows: rows.slice(0, height), hits: hits.filter((hit) => hit.row < height) }
}

/** The state glyph carries the colour; the name stays readable. */
function paintGlyph(line: string, pane: AgentPane, skin: Skin): string {
  const mark = glyph(pane)
  const colour =
    pane.waiting || pane.state === 'blocked'
      ? skin.waiting
      : pane.state === 'failed'
        ? skin.bad
        : pane.state === 'review'
          ? skin.done
          : pane.state === 'working'
            ? skin.busy
            : skin.hint
  return line.replace(mark, colour(mark))
}

/**
 * What is in the worktree you are watching.
 *
 * Enough to know where you are without leaving the window — not a file
 * browser, which is what your editor is for.
 */
function renderFiles(files: readonly string[], width: number, height: number, skin: Skin): Drawn {
  if (height <= 0) return { rows: [], hits: [] }
  const rows =
    height > 2 ? ['', skin.label(clip(' FILES', width))] : [skin.label(clip(' FILES', width))]
  const hits: Hit[] = []
  for (const path of files) {
    if (rows.length >= height) break
    hits.push(rowHit(rows.length, width, { kind: 'file', path }))
    rows.push(path.endsWith('/') ? skin.busy(clip(`  ${path}`, width)) : clip(`  ${path}`, width))
  }
  if (hits.length === 0) rows.push(skin.hint(clip('  —', width)))
  return { rows: rows.slice(0, height), hits: hits.filter((hit) => hit.row < height) }
}

function renderMain(
  state: AppState,
  screen: string,
  width: number,
  height: number,
  skin: Skin,
): string[] {
  const pane = state.panes.find((p) => p.task === state.focused)
  if (!pane) {
    // The window everybody sees first. It has to say what to do next, not
    // report that there is nothing to report.
    const lines = [
      skin.you(
        clip(state.panes.length === 0 ? ' Nothing is running yet.' : ' Watching nothing.', width),
      ),
      '',
      skin.hint(clip('   /task      create a task and start work on it', width)),
      skin.hint(clip('   /project   add a repository Wilco can work in', width)),
      skin.hint(clip('   /settings  see and change what Wilco has been told', width)),
      '',
      skin.hint(clip(' Type / below for the rest, or just say what you want.', width)),
    ]
    return lines.slice(0, height)
  }

  const title = ` ${paneTitle(pane)}`
  const note = pane.waiting ? skin.waiting('● waiting on you ') : ''
  const spare = width - visibleWidth(title) - visibleWidth(note)
  const lines = [
    spare > 0 ? `${skin.you(title)}${' '.repeat(spare)}${note}` : skin.you(clip(title, width)),
    skin.chrome('─'.repeat(width)),
  ]
  const body = height - lines.length
  if (body <= 0) return lines.slice(0, height)

  if (!pane.lane) {
    lines.push(skin.hint(clip(` ${pane.state}, no screen attached`, width)))
    return lines
  }
  // The newest output is the point, so keep the tail.
  for (const line of screen.split('\n').slice(-body)) lines.push(clip(line, width))
  return lines
}

function renderStrip(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
): Drawn {
  const here = state.focused === null ? ' ── here ' : ' '
  const keys = ' ctrl+space talks · / commands '
  const title = `━ orchestrator${state.listening ? ' ── ⏺ listening ' : here}`
  const bar = `${title}${'━'.repeat(Math.max(0, width - title.length - keys.length))}${keys}`
  const rows = [skin.chrome(pad(bar, width))]
  const hits: Hit[] = [rowHit(0, width, { kind: 'orchestrator' })]
  const room = height - 1

  // Its own screen, where it is running somewhere we can see it: the thing you
  // are talking to is a terminal like any other, and watching it work beats
  // reading a summary of what it did.
  if (frame.orchestrator !== undefined && !isAction(state.dictation)) {
    for (const line of frame.orchestrator.split('\n').slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(pad(clip(line, width), width))
    }
    while (rows.length < height) rows.push(' '.repeat(width))
    return { rows: rows.slice(0, height), hits }
  }

  const body: string[] = []
  if (state.question) {
    body.push(skin.waiting(clip(` ? ${state.question.question}`, width)))
    body.push(skin.hint(clip(`   ${state.question.candidates.join('  ·  ')}`, width)))
  }
  for (const turn of state.turns) body.push(...renderTurn(turn, width, skin))
  if (state.notice) body.push(skin.hint(clip(` · ${state.notice}`, width)))
  if (body.length === 0) {
    body.push(skin.hint(clip(' say what you want, or / for what Wilco can do', width)))
  }

  // Reaching for a command: the list is more use than the transcript, so it
  // takes the room.
  if (isAction(state.dictation)) {
    const found = matchActions(state, state.dictation ?? '')
    for (const action of found.slice(0, Math.max(1, height - 2))) {
      const line = ` ${action.name.padEnd(10)} ${action.about}`
      body.push(action.ready ? clip(line, width) : skin.hint(clip(line, width)))
    }
    if (found.length === 0) body.push(skin.hint(clip('  no command like that', width)))
  }

  // Last, and with a cursor, because it is what you are doing right now.
  // `◉` while the microphone is open, `❯` while you type: the same line, and
  // which one it is matters, because one of them is recording you.
  if (state.dictation !== null) {
    const line = ` ${state.listening ? '◉' : '❯'} ${state.dictation}▏`
    body.push(state.listening ? skin.waiting(clip(line, width)) : skin.you(clip(line, width)))
  }
  // Typed at an agent, but held back because it might be meant for Wilco.
  if (state.held) body.push(skin.hint(clip(` ◌ ${state.held}▏`, width)))

  // The last thing said is what you need to see, and it belongs next to the
  // line you are about to type — so the gap goes above, not below.
  const shown = body.slice(-room)
  for (let blank = room - shown.length; blank > 0; blank--) rows.push(' '.repeat(width))
  for (const line of shown) {
    hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
    rows.push(pad(line, width))
  }
  return { rows: rows.slice(0, height), hits }
}

/**
 * One exchange: what was heard, where it went and why, then the answer. The
 * reasoning is shown so a wrong guess is obvious and can be corrected.
 */
export function renderTurn(turn: Turn, width: number, skin: Skin = PLAIN): string[] {
  const lines = [skin.you(clip(` ❯ ${turn.utterance}`, width))]
  const parts: string[] = [turn.intent]
  if (turn.task) parts.push(turn.task)
  if (turn.why) parts.push(`"${turn.why}"`)
  lines.push(skin.hint(clip(`   → ${parts.join(' · ')}`, width)))
  if (turn.reply) lines.push(clip(`   ${turn.reply}`, width))
  return lines
}

/** Cut to the visible width, leaving any ANSI in the line intact. */
function clip(text: string, width: number): string {
  return visibleWidth(text) > width ? truncateToWidth(text, width) : text
}

function pad(text: string, width: number): string {
  const short = clip(text, width)
  return short + ' '.repeat(Math.max(0, width - visibleWidth(short)))
}
