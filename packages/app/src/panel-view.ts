import type { Setting, SettingGroup } from '@wilco/core'
import type { ParsedDiff } from './diff.ts'
import type { Hit } from './hits.ts'
import { checkTalkKey, keyCaps, TALK_SUGGESTIONS } from './keys.ts'
import { type AgentPane, glyph } from './model.ts'
import {
  ACCOUNTS,
  branchPreview,
  type Choice,
  type ConfirmRemovePanel,
  choicesFor,
  type DiffPanel,
  type MenuItem,
  type MenuPanel,
  matchingChoices,
  matchingEntries,
  type NewTaskPanel,
  nameFrom,
  type OpenProjectPanel,
  type OpenRow,
  type PaletteEntry,
  type PalettePanel,
  type Panel,
  type QuitPanel,
  type SettingsPanel,
  type SpendPanel,
  usesDropdown,
  visibleSettings,
} from './panels.ts'
import type { Skin } from './skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendView } from './spend.ts'
import { blank, box, type Drawn, fit as fitRow, type Pointer, Row } from './ui.ts'
import type { Change } from './view.ts'

// How each panel looks. The model of what a panel holds and what a key does to
// it is in `panels.ts`; this only draws it, and names each control so a click
// can find its way back there.

export interface PanelContext {
  width: number
  height: number
  skin: Skin
  pointer: Pointer
  /** Wilco's home, as you would type it: where worktrees are made. */
  home: string
  route: { harness: string; model: string | null; provider: string | null } | null
  /** Where the money went, for the window and grouping the Spend panel is on. */
  spend: SpendView | null
  /** The tasks, for giving each spend row its state. */
  panes: readonly AgentPane[]
  /** The project you are in: its tasks are named short. */
  project: string | null
  /** A task's menu, as it stands. */
  items: readonly MenuItem[]
  /** What a task has changed, for the question before removing it. */
  changes: readonly Change[]
  /** Commits the task's branch has that its base does not. */
  ahead: number | null
  branch: string | null
  base: string | null
  /** The file the diff panel is showing, once git has said. */
  diff: ParsedDiff | null
  /** Models an agent can be started on. */
  choices: readonly Choice[]
  /** Every setting, grouped, as it is now. */
  settings: readonly SettingGroup[]
  /** Providers pi is signed in to. */
  accounts: readonly string[]
  /** The config file, as you would type its path. */
  configPath: string
  /** Whether this terminal reports key releases, which holding to talk needs. */
  releases: boolean
  /** Projects over or near their budget today. */
  budgetWarnings: number
  /** How loud the microphone is, while it is being tried. */
  levels: readonly number[]
  /** The Open project list, with what is known about each row. */
  openRows: readonly OpenRowView[]
  /** The folder being browsed, as you would type it. */
  browsing: string | null
  /** Your home directory, which paths are shown relative to. */
  homeDir: string
  /** Everything the palette can go to. */
  entries: readonly PaletteEntry[]
  /** The key you talk with, and how. */
  talkKey: string
  talkMode: 'hold' | 'toggle'
  /** Agents that closing would stop. */
  running: number
}

export interface OpenRowView {
  row: OpenRow
  branch: string | null
  tasks: number
  /** When it was last opened, said the way people say it. */
  when: string | null
}

/** A panel, and anything that opens out of it and may reach past its edge. */
export interface PanelDrawing {
  panel: Drawn
  /** Drawn over the panel, at a place relative to its top-left corner. */
  popups: { drawn: Drawn; row: number; col: number }[]
}

export function drawPanel(panel: Panel, ctx: PanelContext): PanelDrawing {
  switch (panel.kind) {
    case 'new-task':
      return newTask(panel, ctx)
    case 'spend':
      return { panel: spend(panel, ctx), popups: [] }
    case 'menu':
      return { panel: menu(panel, ctx), popups: [] }
    case 'confirm-remove':
      return { panel: confirmRemove(panel, ctx), popups: [] }
    case 'diff':
      return { panel: diff(panel, ctx), popups: [] }
    case 'settings':
      return settings(panel, ctx)
    case 'open-project':
      return { panel: openProject(panel, ctx), popups: [] }
    case 'palette':
      return { panel: palette(panel, ctx), popups: [] }
    case 'keys':
      return { panel: keysSheet(ctx), popups: [] }
    case 'quit':
      return { panel: quit(panel, ctx), popups: [] }
  }
}

function palette(panel: PalettePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(74, ctx.width - 4)
  const inner = width - 2
  const found = matchingEntries(ctx.entries, panel.query)
  const room = Math.max(4, Math.min(14, ctx.height - 10))
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(panel.query, inner - 2, { caret: true })
      .build(),
    blank(inner),
  ]
  const start = Math.max(0, Math.min(panel.index - room + 1, found.length - room))
  found.slice(start, start + room).forEach((entry, offset) => {
    const at = start + offset
    const on = at === panel.index
    const target = { kind: 'control' as const, id: `entry:${entry.id}` }
    const tone = entry.tone ? skin[entry.tone] : skin.tab
    const r = new Row(inner, skin)
      .text(on ? '▌' : ' ', skin.signal)
      .text(entry.mark, tone)
      .space()
    if (entry.note) {
      // A task that needs you says where it is beside its name, and why at the edge.
      r.text(pad(entry.label, 20), on ? skin.you : (t: string) => t)
        .space()
        .text(entry.kind, skin.hint)
      r.right((right) => right.text(entry.note ?? '', skin.waiting).space())
    } else {
      r.text(entry.label, on ? skin.you : (t: string) => t)
      r.right((right) => right.text(entry.kind, skin.hint).space())
    }
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    })
  })
  if (found.length === 0)
    rows.push(new Row(inner, skin).space().text('Nothing by that name.', skin.hint).build())
  rows.push(blank(inner))
  rows.push(
    new Row(inner, skin).space().text('↑↓ move · enter go · type to narrow', skin.hint).build(),
  )
  return box('Go to anything', rows, width, skin, { corner: 'ctrl+g' })
}

function keysSheet(ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const label = (text: string) =>
    new Row(inner, skin, ctx.pointer).space().text(pad(text, 17), skin.label)
  const talk = ctx.talkKey
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    label('TALK')
      .keys(keyCaps(talk))
      .space(2)
      .text(
        `${ctx.releases && ctx.talkMode === 'hold' ? 'hold' : 'press to start, press to stop'} · yours to change`,
        skin.hint,
      )
      .build(),
    blank(inner),
    label('GO TO ANYTHING').keys(['ctrl', 'g']).build(),
    label('NEXT AGENT').keys(['tab']).space(2).keys(['shift', 'tab']).build(),
    label('ANSWER')
      .keys(['a'])
      .text(' allow  ', skin.hint)
      .keys(['d'])
      .text(' deny   ', skin.hint)
      .text('only while one waits', skin.hint)
      .build(),
    label('IN A PANEL')
      .keys(['enter'])
      .space()
      .keys(['esc'])
      .space()
      .keys(['↑'])
      .keys(['↓'])
      .build(),
    label('QUIT').keys(['ctrl', 'c']).build(),
    blank(inner),
    new Row(inner, skin)
      .space()
      .text("Everything else goes to the agent you're watching.", skin.hint)
      .build(),
    new Row(inner, skin, ctx.pointer)
      .right((r) => r.button('Change keys…', { kind: 'control', id: 'change-keys' }).space())
      .build(),
  ]
  return box('Keys', rows, width, skin, { corner: 'esc' })
}

function quit(panel: QuitPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(62, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const running = ctx.running
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row()
      .space()
      .text(
        `${running} agent${running === 1 ? ' is' : 's are'} running inside this window.`,
        skin.you,
      )
      .build(),
    blank(inner),
    row()
      .space()
      .text('Agents here run under ')
      .text('pty', skin.busy)
      .text(', so closing stops them. Their')
      .build(),
    row().space().text('conversations are kept, and each one picks up where it').build(),
    row().space().text('stopped the next time you open its task.').build(),
    blank(inner),
    row().space().text('Under tmux they would keep working after you close.', skin.hint).build(),
    row()
      .space()
      .text('Settings › Agents › Where agents run', skin.link, { kind: 'control', id: 'where' })
      .build(),
    blank(inner),
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button('Stop agents and close', { kind: 'control', id: 'quit' }, 'attention')
          .space(),
      )
      .build(),
  ]
  return box('Close Wilco?', rows, width, skin, { corner: 'esc' })
}

function openProject(panel: OpenProjectPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(74, ctx.width - 4)
  const inner = width - 2
  const pointer =
    ctx.pointer.hover || (panel.field !== 'init' && panel.field !== 'name')
      ? ctx.pointer
      : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []

  rows.push(
    row()
      .space()
      .field(panel.query, 50, {
        caret: panel.field === 'query',
        target: { kind: 'control', id: 'query' },
      })
      .right((r) => r.text('a path, or a name', skin.hint).space())
      .build(),
  )
  rows.push(blank(inner))

  const recent = ctx.openRows.filter((view) => view.row.kind === 'recent')
  const folders = ctx.openRows.filter((view) => view.row.kind === 'folder')
  const room = Math.max(4, Math.min(14, ctx.height - 18))
  // Wide enough for the longest name shown, within reason.
  const folderWidth = Math.min(28, Math.max(14, ...folders.map((view) => view.row.name.length + 3)))
  const line = (view: OpenRowView) => {
    const at = ctx.openRows.indexOf(view)
    const on = at === panel.index
    const target = { kind: 'control' as const, id: `row:${at}` }
    const r = new Row(inner, skin).text(on ? '▌' : ' ', skin.signal).space()
    if (view.row.kind === 'recent') {
      r.text(pad(view.row.name, 12), on ? skin.you : (t: string) => t)
      r.text(pad(tildeOf(view.row.path, ctx.homeDir), 20))
      r.text(pad(view.branch ?? '', 8), skin.hint)
      if (view.tasks > 0) r.badge(view.tasks)
      r.right((right) => right.text(view.when ?? '', skin.hint).space())
    } else {
      r.text(pad(`${view.row.name}/`, folderWidth), skin.busy)
      r.text(
        view.row.git ? `git · ${view.branch ?? 'repository'}` : 'not a git repository',
        view.row.git ? skin.hint : skin.waiting,
      )
    }
    const built = r.build()
    return {
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    }
  }

  if (recent.length > 0) {
    rows.push(row().space().text('RECENT', skin.label).build())
    for (const view of recent.slice(0, room)) rows.push(line(view))
    rows.push(blank(inner))
  }
  if (ctx.browsing !== null) {
    rows.push(
      row()
        .space()
        .text(`IN ${ctx.browsing}`, skin.label)
        .right((r) => r.text('← up · → into', skin.hint).space())
        .build(),
    )
    if (folders.length === 0) rows.push(row().space(3).text('no folders here', skin.hint).build())
    for (const view of folders.slice(0, room)) rows.push(line(view))
    rows.push(blank(inner))
  }
  if (recent.length === 0 && ctx.browsing === null) {
    rows.push(
      row().space().text('Nothing matches. Type a path to browse: ~/src/', skin.hint).build(),
    )
    rows.push(blank(inner))
  }

  const chosen = ctx.openRows[panel.index]?.row
  if (chosen && !chosen.git) {
    rows.push(
      row()
        .space()
        .text('▲ ', skin.waiting)
        .text(`${chosen.name} isn't a git repository. Tasks are git worktrees,`)
        .build(),
    )
    rows.push(row().space(3).text('so Wilco needs one before it can start work there.').build())
    rows.push(
      row()
        .space(3)
        .check(panel.init, "git init, and commit what's there as the first commit", {
          kind: 'control',
          id: 'init',
        })
        .build(),
    )
    rows.push(blank(inner))
  }
  if (panel.error) {
    rows.push(row().space().text(`▲ ${panel.error}`, skin.waiting).build())
    rows.push(blank(inner))
  }

  const known = chosen?.kind === 'recent'
  const name = known ? chosen.name : (panel.name ?? (chosen ? nameFrom(chosen.path) : ''))
  rows.push(
    row()
      .space()
      .text('Name  ', skin.hint)
      .field(name, 26, {
        caret: panel.field === 'name' && !known,
        hint: known,
        target: { kind: 'control', id: 'name' },
      })
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button(
            panel.busy ? 'Opening…' : known ? 'Go to project' : 'Open project',
            { kind: 'control', id: 'open' },
            panel.busy || !chosen || (!chosen.git && !panel.init) ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )
  return box('Open a project', rows, width, skin, { corner: 'esc' })
}

function tildeOf(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

// ── Settings ────────────────────────────────────────────────────────────────

const CHOICE_LABELS: Record<string, string> = {
  hold: 'Hold to talk',
  toggle: 'Press to start, press to stop',
}

const SIDE = 24
const LABEL = 18

function settings(panel: SettingsPanel, ctx: PanelContext): PanelDrawing {
  const { skin } = ctx
  const width = Math.min(104, ctx.width - 6)
  const height = Math.max(14, Math.min(28, ctx.height - 4))
  const inner = width - 2
  const form = inner - SIDE - 1
  const pointer = ctx.pointer

  // ── the side: search, then categories ──
  const side: { text: string; hits: Hit[] }[] = []
  side.push(
    new Row(SIDE, skin, pointer)
      .space()
      .field(panel.search, SIDE - 2, {
        caret: panel.focus === 'search',
        hint: panel.search === '' && panel.focus !== 'search',
        target: { kind: 'control', id: 'search' },
      })
      .build(),
  )
  if (panel.search === '' && panel.focus !== 'search') {
    // The field says what it is for until you use it.
    side[0] = new Row(SIDE, skin, pointer)
      .space()
      .field('search settings', SIDE - 2, { hint: true, target: { kind: 'control', id: 'search' } })
      .build()
  }
  side.push({ text: ' '.repeat(SIDE), hits: [] })
  const categories = [
    ...ctx.settings.map((group) => ({ id: group.id, title: group.title })),
    { id: ACCOUNTS, title: 'Accounts' },
  ]
  for (const category of categories) {
    const on = panel.search === '' && panel.category === category.id
    const target = { kind: 'control' as const, id: `category:${category.id}` }
    const row = new Row(SIDE, skin, pointer)
      .text(on ? '▌' : ' ', skin.signal, target)
      .space()
      .text(category.title, on ? skin.you : (t: string) => t, target)
    row.right((r) => {
      const badge = badgeFor(category.id, ctx)
      if (badge) badge(r)
      r.space()
    })
    const built = row.build()
    side.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: SIDE - 1, target }],
    })
  }

  // ── the form ──
  const main: { text: string; hits: Hit[] }[] = []
  const group = ctx.settings.find((g) => g.id === panel.category)
  const title = panel.search
    ? `Matching “${panel.search}”`
    : panel.category === ACCOUNTS
      ? 'Accounts'
      : (group?.title ?? '')
  const about = panel.search
    ? 'Every setting whose name or meaning has those words.'
    : panel.category === ACCOUNTS
      ? 'The providers pi can think with. Signing in happens in pi, inside this window.'
      : (group?.about ?? '')
  main.push(new Row(form, skin).space().text(title, skin.brand).build())
  main.push(new Row(form, skin).space().text(about, skin.hint).build())
  main.push({ text: ' '.repeat(form), hits: [] })

  const popups: PanelDrawing['popups'] = []
  if (panel.category === ACCOUNTS && !panel.search) {
    for (const provider of ctx.accounts) {
      main.push(
        new Row(form, skin)
          .space()
          .text(pad(provider, LABEL))
          .text('● signed in', skin.done)
          .build(),
      )
    }
    if (ctx.accounts.length === 0)
      main.push(
        new Row(form, skin).space().text('Not signed in to anything yet.', skin.hint).build(),
      )
    main.push({ text: ' '.repeat(form), hits: [] })
    main.push(
      new Row(form, skin, withFocus(pointer, panel.focus === 'form' ? 'sign-in' : null))
        .space()
        .button('Sign in to a provider…', { kind: 'control', id: 'sign-in' }, 'primary')
        .build(),
    )
  } else {
    const rows = visibleSettings(panel, ctx.settings)
    if (rows.length === 0)
      main.push(new Row(form, skin).space().text('Nothing here matches.', skin.hint).build())
    rows.forEach((setting, at) => {
      const focused = panel.focus === 'form' && at === panel.row
      const line = new Row(form, skin, focused ? withFocus(pointer, controlOf(setting)) : pointer)
      line.text(focused ? '▌' : ' ', skin.signal, { kind: 'control', id: `row:${setting.path}` })
      line.text(pad(setting.title, LABEL), focused ? skin.you : (t: string) => t, {
        kind: 'control',
        id: `row:${setting.path}`,
      })
      const controlCol = line.used
      control(line, setting, panel, ctx)
      if (!setting.live) line.right((r) => r.text('↻ on restart', skin.hint).space())
      main.push(line.build())
      if (setting.path === 'surfaces.voice.mic.device') {
        // Trying it is the only way to know the terminal may use it.
        const meter = new Row(form, skin, pointer).space(1 + LABEL)
        const cells = 14
        const heard = ctx.levels.slice(-cells)
        const bars = '▁▂▃▄▅▆▇█'
        meter.text(
          heard.map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))]).join(''),
          skin.busy,
        )
        meter.text('▁'.repeat(cells - heard.length), skin.chrome).space(2)
        meter.button(
          panel.testing ? 'Listening…' : 'Test',
          { kind: 'control', id: 'mic-test' },
          panel.testing ? 'off' : 'rest',
        )
        main.push(meter.build())
      }
      if (panel.dropdown?.path === setting.path) {
        popups.push({
          drawn: settingsDropdown(panel, setting, ctx),
          row: 1 + main.length,
          col: 1 + SIDE + 1 + controlCol,
        })
      }
      // The sentence under a setting, for the one you are on, and what the
      // terminal allows for the talk key, which is not something to guess.
      const roomy =
        setting.type.kind === 'key' ||
        setting.type.kind === 'model' ||
        setting.type.kind === 'choice'
      const listOpen = panel.dropdown?.path === setting.path
      if (!listOpen && (focused || (setting.type.kind === 'key' && panel.search === ''))) {
        const note =
          setting.type.kind === 'key'
            ? ctx.releases
              ? {
                  mark: '✓',
                  text: 'Hold works here: this terminal reports releases.',
                  tone: skin.done,
                }
              : {
                  mark: '▲',
                  text: "This terminal can't report releases, so talking toggles.",
                  tone: skin.waiting,
                }
            : { mark: '', text: setting.means, tone: skin.hint }
        const r = new Row(form, skin).space(1 + LABEL)
        if (note.mark) r.text(note.mark, note.tone).space()
        r.text(note.text, skin.hint)
        main.push(r.build())
      }
      // Settings that say more than one line's worth stand apart; plain ones stack.
      if (roomy && at < rows.length - 1) main.push({ text: ' '.repeat(form), hits: [] })
    })
  }

  // ── the foot of the form ──
  const foot = new Row(form, skin, pointer).space()
  if (panel.error) foot.text(`▲ ${panel.error}`, skin.waiting)
  else if (panel.saved) foot.text('● ', skin.done).text(panel.saved, skin.hint)
  else foot.text('● ', skin.done).text('Saved as you change it.', skin.hint)
  const buttons = new Row(form, skin, pointer).right((r) =>
    r
      .button('Open config.yaml', { kind: 'control', id: 'open-file' })
      .space()
      .button('Done', { kind: 'control', id: 'done' }, 'primary')
      .space(),
  )

  const body = height - 2
  const lines: { text: string; hits: Hit[] }[] = []
  for (let i = 0; i < body; i++) {
    const left = side[i] ?? { text: ' '.repeat(SIDE), hits: [] }
    let right = main[i] ?? { text: ' '.repeat(form), hits: [] }
    if (i === body - 2) right = foot.build()
    if (i === body - 1) right = buttons.build()
    lines.push({
      text: `${fitTo(left.text, SIDE)}${skin.chrome('│')}${fitTo(right.text, form)}`,
      hits: [
        ...left.hits,
        ...right.hits.map((hit) => ({ ...hit, from: hit.from + SIDE + 1, to: hit.to + SIDE + 1 })),
      ],
    })
  }

  if (panel.capture) {
    popups.push({
      drawn: capture(panel, ctx),
      row: 3,
      col: Math.max(2, Math.floor((width - 62) / 2)),
    })
  }
  return {
    panel: box('Settings', lines, width, skin, { corner: `${ctx.configPath} · esc` }),
    popups,
  }
}

/** The control on the right of a setting, drawn for its kind. */
function control(row: Row, setting: Setting, panel: SettingsPanel, ctx: PanelContext): void {
  const { skin } = ctx
  const type = setting.type
  const value = setting.value
  switch (type.kind) {
    case 'key':
      row.keys(keyCaps(value || setting.fallback)).space(3)
      row.button('Change…', { kind: 'control', id: `capture:${setting.path}` })
      return
    case 'flag':
      row.toggle((value || setting.fallback) === 'true', {
        kind: 'control',
        id: `toggle:${setting.path}`,
      })
      return
    case 'number': {
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, 10, {
          caret: true,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
        return
      }
      row
        .text(skin.colour ? ' ‹ ' : '[-]', skin.signal, {
          kind: 'control',
          id: `step:${setting.path}=-1`,
        })
        .text(` ${value || setting.fallback} `, value ? skin.you : skin.hint, {
          kind: 'control',
          id: `edit:${setting.path}`,
        })
        .text(skin.colour ? ' › ' : '[+]', skin.signal, {
          kind: 'control',
          id: `step:${setting.path}=1`,
        })
      if (type.unit) row.space(2).text(type.unit, skin.hint)
      return
    }
    case 'hours': {
      const target = { kind: 'control' as const, id: `edit:${setting.path}` }
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, 16, { caret: true, target })
        row.space(2).text('like 22:00-07:00', skin.hint)
        return
      }
      const [from, to] = value.split('-')
      if (!value || !from || !to) {
        row.field('none', 9, { hint: true, target })
        return
      }
      row.field(from, 9, { target }).space().text('to', skin.hint).space().field(to, 9, { target })
      return
    }
    case 'text':
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, 40, {
          caret: true,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
      } else {
        row.field(value || setting.fallback, 40, {
          hint: !value,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
      }
      return
    case 'model':
    case 'choice':
      if (usesDropdown(setting)) {
        const shown =
          type.kind === 'choice'
            ? (type.about?.[value || setting.fallback]?.label ?? (value || setting.fallback))
            : value || setting.fallback
        row.field(shown, 40, {
          arrow: true,
          hint: !value,
          target: { kind: 'control', id: `drop:${setting.path}` },
        })
        return
      }
      if (type.kind === 'choice') {
        type.options.forEach((option, i) => {
          if (i > 0) row.space(3)
          row.radio((value || setting.fallback) === option, CHOICE_LABELS[option] ?? option, {
            kind: 'control',
            id: `set:${setting.path}=${option}`,
          })
        })
      }
      return
  }
}

/** The control the keyboard would operate, so it looks the part. */
function controlOf(setting: Setting): string | null {
  switch (setting.type.kind) {
    case 'key':
      return `capture:${setting.path}`
    case 'flag':
      return `toggle:${setting.path}`
    case 'text':
    case 'hours':
      return `edit:${setting.path}`
    default:
      return usesDropdown(setting) ? `drop:${setting.path}` : null
  }
}

function withFocus(pointer: Pointer, id: string | null): Pointer {
  if (!id || pointer.hover) return pointer
  return { ...pointer, hover: { kind: 'control', id } }
}

/** A badge beside a category, when something there is worth a look. */
function badgeFor(id: string, ctx: PanelContext): ((row: Row) => void) | null {
  const { skin } = ctx
  if (id === 'approvals') {
    const mode = ctx.settings.find((g) => g.id === 'approvals')?.settings[0]?.value
    return mode ? (row) => row.text(mode, skin.hint) : null
  }
  if (id === 'projects') {
    const count = ctx.settings.find((g) => g.id === 'budgets')?.settings.length ?? 0
    return count > 0 ? (row) => row.badge(count) : null
  }
  if (id === 'budgets' && ctx.budgetWarnings > 0)
    return (row) => row.text(`● ${ctx.budgetWarnings}`, skin.waiting)
  if (id === ACCOUNTS && ctx.accounts.length > 0)
    return (row) => row.text(`● ${ctx.accounts.length}`, skin.done)
  return null
}

/** A setting's list, opened under it: grouped, narrowed by typing, the current one ticked. */
function settingsDropdown(panel: SettingsPanel, setting: Setting, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = 46
  const inner = width - 2
  const query = panel.dropdown?.query ?? ''
  const found = matchingChoices(choicesFor(setting, ctx.choices), query)
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(query, inner - 2, { caret: true })
      .build(),
  ]
  let group = ''
  found.slice(0, 12).forEach((choice, index) => {
    if (
      choice.group !== group &&
      (setting.type.kind === 'model' || (setting.type.kind === 'choice' && setting.type.about))
    ) {
      group = choice.group
      // What a group needs is said once, at its heading: every option under it shares it.
      const note = choice.note
      const heading = new Row(inner, skin).space().text(group.toUpperCase(), skin.label)
      if (note) heading.right((r) => r.text(note, skin.hint).space())
      rows.push(heading.build())
    }
    const on = index === (panel.dropdown?.index ?? 0)
    const target = { kind: 'control' as const, id: `choose:${choice.value}` }
    const r = new Row(inner, skin)
      .text(on ? '▌' : ' ', skin.signal)
      .space()
      .text(choice.label, on ? skin.you : (t: string) => t)
    r.right((right) => {
      right
        .text(choice.value === (setting.value || setting.fallback) ? '✓' : ' ', skin.done)
        .space()
    })
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    })
  })
  if (found.length === 0)
    rows.push(new Row(inner, skin).space().text('Nothing matches that.', skin.hint).build())
  return box('', rows, width, skin, { corner: '▴' })
}

/** Press the keys you want to hold to talk. */
function capture(panel: SettingsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = 62
  const inner = width - 2
  const pressed = panel.capture?.key ?? null
  const check = pressed ? checkTalkKey(pressed) : null
  const row = () => new Row(inner, skin, ctx.pointer)
  const rows: { text: string; hits: Hit[] }[] = [
    { text: ' '.repeat(inner), hits: [] },
    row()
      .right((r) => r.text('Press the keys you want to hold to talk.', skin.you).space(8))
      .build(),
    { text: ' '.repeat(inner), hits: [] },
  ]
  const caps = row()
  if (pressed) {
    const width =
      keyCaps(pressed).reduce((sum, k) => sum + k.length + 4, 0) + keyCaps(pressed).length - 1
    caps.space(Math.max(1, Math.floor((inner - width) / 2))).keys(keyCaps(pressed))
  } else {
    caps.space(Math.floor((inner - 13) / 2)).text('waiting for a key', skin.hint)
  }
  rows.push(caps.build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  if (check && !check.ok) {
    rows.push(row().space().text(`▲ ${check.reason}`, skin.bad).build())
  } else if (check?.ok && check.warning) {
    const [first, ...rest] = check.warning.split('. ')
    rows.push(row().space().text(`▲ ${first}.`, skin.waiting).build())
    if (rest.length > 0) rows.push(row().space(3).text(rest.join('. '), skin.hint).build())
  } else if (check?.ok) {
    rows.push(row().space().text('✓ Nothing in pi or your shell uses this.', skin.done).build())
  } else {
    rows.push({ text: ' '.repeat(inner), hits: [] })
  }
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const suggested = row().space().text('Suggested: ', skin.hint)
  TALK_SUGGESTIONS.forEach((key, i) => {
    if (i > 0) suggested.space()
    const at = suggested.used
    suggested.keys(keyCaps(key))
    void at
  })
  const built = suggested.build()
  // Each suggestion is a click that picks it.
  let col = 12
  const hits: Hit[] = []
  for (const key of TALK_SUGGESTIONS) {
    const w = keyCaps(key).reduce((sum, k) => sum + k.length + 4, 0) + keyCaps(key).length - 1
    hits.push({
      row: 0,
      from: col,
      to: col + w - 1,
      target: { kind: 'control', id: `capture-suggest:${key}` },
    })
    col += w + 1
  }
  rows.push({ text: built.text, hits })
  rows.push(
    row().space().text('Never a key that types a character — you have to be', skin.hint).build(),
  )
  rows.push(row().space().text('able to type a space into your agent.', skin.hint).build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const usable = check?.ok === true
  rows.push(
    row()
      .right((r) =>
        r
          .button(usable ? 'Try another' : 'Cancel', { kind: 'control', id: 'capture-cancel' })
          .space()
          .button(
            usable && pressed
              ? check.warning
                ? `Use ${pressed} anyway`
                : `Use ${pressed}`
              : 'Use it',
            { kind: 'control', id: 'capture-use' },
            usable ? (check.warning ? 'attention' : 'primary') : 'off',
          )
          .space(),
      )
      .build(),
  )
  return box('Push to talk', rows, width, skin, { corner: 'esc' })
}

function fitTo(text: string, width: number): string {
  return fitRow(text, width)
}

function menu(panel: MenuPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = 30
  const inner = width - 2
  const rows: { text: string; hits: Hit[] }[] = []
  ctx.items.forEach((item, at) => {
    if (item.divider) rows.push({ text: skin.chrome('─'.repeat(inner)), hits: [] })
    const target = { kind: 'control' as const, id: `item:${item.id}` }
    const on =
      at === panel.index ||
      (ctx.pointer.hover?.kind === 'control' && ctx.pointer.hover.id === target.id)
    const row = new Row(inner, skin).text(on && !item.off ? '▌' : ' ', skin.signal).space()
    const paint = item.off ? skin.faded : item.danger ? skin.bad : on ? skin.you : (t: string) => t
    row.text(item.label, paint, item.off ? undefined : target)
    const note = item.off ?? item.note
    if (note) row.right((r) => r.text(note, skin.hint).space())
    const built = row.build()
    rows.push({
      text: on && !item.off ? skin.selected(built.text) : built.text,
      hits: built.hits.map((hit) => ({ ...hit, from: 0, to: inner - 1 })),
    })
  })
  const name = panel.task.split('/').at(-1) ?? panel.task
  return box(name, rows, width, skin)
}

function confirmRemove(panel: ConfirmRemovePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const name = panel.task.split('/').at(-1) ?? panel.task
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]

  const unmerged = ctx.changes.length > 0 || (ctx.ahead ?? 0) > 0
  if (unmerged) {
    rows.push(row().space().text("Its worktree has work that isn't merged:").build())
    for (const change of ctx.changes.slice(0, 6)) {
      const tone =
        change.mark === 'A' || change.mark === '?'
          ? skin.done
          : change.mark === 'D'
            ? skin.bad
            : skin.waiting
      rows.push(row().space(3).text(change.mark, tone).space().text(change.path).build())
    }
    if (ctx.changes.length > 6)
      rows.push(
        row()
          .space(5)
          .text(`and ${ctx.changes.length - 6} more`, skin.hint)
          .build(),
      )
    if ((ctx.ahead ?? 0) > 0 && ctx.branch) {
      const commits = `${ctx.ahead} commit${ctx.ahead === 1 ? '' : 's'}`
      rows.push(
        row()
          .space(3)
          .text(
            `${commits} on ${ctx.branch} that ${ctx.base ?? 'its base'} doesn't have`,
            skin.hint,
          )
          .build(),
      )
    }
  } else {
    rows.push(row().space().text('Nothing in it is unmerged.').build())
  }
  rows.push(blank(inner))
  rows.push(row().space().text("Removing deletes the worktree and the branch. The agent's").build())
  rows.push(row().space().text("conversation stays in pi's sessions.").build())
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  rows.push(
    row()
      .right((r) =>
        r
          .button('Keep it', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Removing…' : unmerged ? 'Remove anyway' : 'Remove',
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  )
  return box(`Remove ${name}?`, rows, width, skin, { corner: 'esc' })
}

function diff(panel: DiffPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(96, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const path = panel.files[panel.file] ?? ''
  const name = panel.task.split('/').at(-1) ?? panel.task
  const room = Math.max(6, Math.min(24, ctx.height - 10))
  const rows: { text: string; hits: Hit[] }[] = []
  const parsed = ctx.diff

  if (!parsed) {
    rows.push(row().space().text('reading the diff…', skin.hint).build())
  } else if (parsed.binary) {
    rows.push(row().space().text('A binary file: there are no lines to show.', skin.hint).build())
  } else if (parsed.lines.length === 0) {
    rows.push(row().space().text('No differences from where the task branched.', skin.hint).build())
  } else {
    const numberWidth = String(
      Math.max(...parsed.lines.map((line) => line.new ?? line.old ?? 0)),
    ).length
    const scroll = Math.min(panel.scroll, Math.max(0, parsed.lines.length - room))
    for (const line of parsed.lines.slice(scroll, scroll + room)) {
      const r = row().space()
      if (line.kind === 'hunk') {
        r.text(line.text, skin.hint)
      } else {
        const number = String((line.kind === 'remove' ? line.old : line.new) ?? '').padStart(
          numberWidth,
        )
        r.text(number, skin.hint).space()
        const sign = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '
        const tone =
          line.kind === 'add' ? skin.done : line.kind === 'remove' ? skin.bad : (t: string) => t
        r.text(`${sign}${line.text}`, tone)
      }
      rows.push(r.build())
    }
  }
  while (rows.length < Math.min(room, 4)) rows.push(blank(inner))
  rows.push(blank(inner))
  rows.push(
    row()
      .space()
      .button('Open in editor', { kind: 'control', id: 'editor' })
      .space()
      .button('Ask the agent about this', { kind: 'control', id: 'ask' })
      .right((r) => {
        if (panel.files.length > 1) {
          r.text('‹', skin.signal, { kind: 'control', id: 'prev-file' })
            .text(` ${panel.file + 1}/${panel.files.length} `, skin.hint)
            .text('›', skin.signal, { kind: 'control', id: 'next-file' })
            .space(2)
        }
        r.text('↑↓ scroll · ←→ file', skin.hint).space()
      })
      .build(),
  )
  const counts =
    parsed && !parsed.binary
      ? `${skin.done(`+${parsed.added}`)} ${skin.bad(`−${parsed.removed}`)} `
      : ''
  return box(`${path} · ${name}`, rows, width, skin, { corner: `${counts}esc` })
}

function spend(panel: SpendPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(74, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const view = ctx.spend
  const rows: { text: string; hits: Hit[] }[] = []

  const head = row().space()
  head.text(view?.hasCost ? money(view.usd) : '—', skin.you).space(2)
  head.text(tokenCount(view?.tokens ?? 0), skin.hint)
  head.right((r) => {
    for (const window of SPEND_WINDOWS) {
      r.tab(
        window.label,
        { kind: 'control', id: `window:${window.id}` },
        panel.window === window.id,
      )
    }
    r.space()
  })
  rows.push(head.build())
  rows.push(blank(inner))

  const by = row().space().text('by ', skin.hint)
  for (const option of SPEND_BY) {
    by.tab(option.label, { kind: 'control', id: `by:${option.id}` }, panel.by === option.id)
  }
  rows.push(by.build())
  rows.push(blank(inner))

  const name = 18
  const model = 16
  const bar = 12
  rows.push(
    row()
      .space()
      .text(
        `${pad('WHO', name + 2)}${pad(panel.by === 'model' ? '' : 'MODEL', model)} ${'TOKENS'.padStart(6)}  ${pad('SHARE', bar)}${'COST'.padStart(8)}`,
        skin.label,
      )
      .build(),
  )
  const total = Math.max(1, view?.tokens ?? 0)
  // The orchestrator first, as its own line: it is the one cost that is not
  // any task's, and the one people forget is running.
  const entries = [...(view?.rows ?? [])].sort(
    (a, b) => Number(b.kind === 'orchestrator') - Number(a.kind === 'orchestrator'),
  )
  if (entries.length === 0) {
    rows.push(row().space(3).text('Nothing spent in this window.', skin.hint).build())
  }
  for (const entry of entries.slice(0, 8)) {
    const pane = ctx.panes.find((p) => p.task === entry.label)
    const mark =
      entry.kind === 'orchestrator'
        ? skin.brand('◆')
        : pane
          ? toneOf(pane, skin)(glyph(pane))
          : skin.hint('·')
    const label = pane && pane.project === ctx.project ? pane.name : entry.label
    rows.push(
      row()
        .space()
        .text(`${mark} `)
        .text(pad(label, name))
        .text(pad(entry.model ? shortModel(entry.model) : '', model), skin.hint)
        .space()
        .text(tokenCount(entry.tokens, false).padStart(6))
        .space(2)
        .meter(entry.tokens / total, bar)
        .text((view?.hasCost ? money(entry.usd) : '—').padStart(8))
        .build(),
    )
  }

  rows.push(blank(inner))
  rows.push(row().space().text('BUDGETS', skin.label).build())
  // Only projects with something to say: a budget, or money spent without one.
  const budgets = (view?.budgets ?? []).filter(
    (budget) => budget.budget || budget.usd > 0 || budget.tokens > 0,
  )
  if (budgets.length === 0) rows.push(row().space(3).text('No budgets set.', skin.hint).build())
  for (const budget of budgets.slice(0, 5)) {
    const line = row().space().text(pad(budget.project, 11))
    const limit = budget.budget?.usd_per_day
    const spent = limit
      ? `${money(budget.usd)} of ${money(limit)} a day`
      : budget.budget?.tokens_per_day
        ? `${tokenCount(budget.tokens, false)} of ${tokenCount(budget.budget.tokens_per_day, false)} a day`
        : money(budget.usd)
    line.text(pad(spent, 25))
    if (budget.share !== null) {
      const tone =
        budget.verdict === 'over' ? skin.bad : budget.verdict === 'warn' ? skin.waiting : skin.done
      line
        .meter(Math.min(1, budget.share), 12, tone)
        .space()
        .text(`${Math.round(budget.share * 100)}%`, skin.hint)
    } else {
      line
        .text('no budget — ', skin.hint)
        .text('set one', skin.link, { kind: 'action', name: 'budgets' })
    }
    rows.push(line.build())
  }
  rows.push(blank(inner))
  rows.push(row().space().text('Prices as pi reports them.', skin.hint).build())

  return box('Spend', rows, width, skin, { corner: 'esc' })
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  if (pane.waiting || pane.state === 'blocked') return skin.waiting
  if (pane.state === 'failed') return skin.bad
  if (pane.state === 'review') return skin.done
  if (pane.state === 'working') return skin.busy
  return skin.hint
}

function pad(text: string, width: number): string {
  const cut = [...text].slice(0, width).join('')
  return cut + ' '.repeat(Math.max(0, width - cut.length))
}

function money(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

function tokenCount(count: number, unit = true): string {
  const suffix = unit ? ' tokens' : ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M${suffix}`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k${suffix}`
  return `${count}${suffix}`
}

function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model
}

/** The control that has the keyboard looks the way it would under the pointer. */
function pointerFor(ctx: PanelContext, focused: string | null): Pointer {
  if (ctx.pointer.hover || !focused) return ctx.pointer
  return { ...ctx.pointer, hover: { kind: 'control', id: focused } }
}

function newTask(panel: NewTaskPanel, ctx: PanelContext): PanelDrawing {
  const { skin } = ctx
  const width = Math.min(76, ctx.width - 4)
  const inner = width - 2
  const pointer = pointerFor(
    ctx,
    panel.field === 'cancel' || panel.field === 'go' ? panel.field : null,
  )
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []

  const projects = row().space().text('Project  ', skin.hint)
  for (const project of panel.projects) {
    projects.tab(project, { kind: 'control', id: `project:${project}` }, project === panel.project)
  }
  if (panel.field === 'project') projects.text('  ← →', skin.hint)
  rows.push(projects.build())
  rows.push(blank(inner))

  rows.push(row().space().text('What needs doing?', skin.you).build())
  rows.push(
    row()
      .space()
      .field(panel.intent, inner - 2, {
        caret: panel.field === 'intent',
        hint: panel.intent === '' && panel.field !== 'intent',
        target: { kind: 'control', id: 'intent' },
      })
      .build(),
  )

  const said = panel.intent.trim()
  const slug = said ? branchPreview(said) : null
  rows.push(
    row()
      .space()
      .text('branch   ', skin.hint)
      .text(slug ?? '—', slug ? (t) => t : skin.hint)
      .build(),
  )
  rows.push(
    row()
      .space()
      .text('worktree ', skin.hint)
      .text(
        slug && panel.project
          ? `${ctx.home}/worktrees/${panel.project}-${slug.slice('wilco/'.length)}`
          : '—',
        skin.hint,
      )
      .build(),
  )
  rows.push(blank(inner))

  const route = ctx.route
  const agentRow = rows.length
  const agent = row().space().text('Agent    ', skin.hint)
  agent.field(
    `${route?.harness ?? 'pi'} · ${panel.model ?? route?.model ?? 'its default model'}`,
    40,
    {
      arrow: true,
      target: { kind: 'control', id: 'model' },
    },
  )
  agent.right((r) => {
    r.check(panel.start, 'start now', { kind: 'control', id: 'start' }).space()
  })
  rows.push(agent.build())

  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )

  rows.push(
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button(
            panel.busy ? 'Starting…' : 'Start task ⏎',
            { kind: 'control', id: 'go' },
            panel.busy ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )

  const drawn = box('New task', rows, width, skin, { corner: 'esc' })
  const popups = panel.dropdown
    ? [{ drawn: modelList(panel, ctx), row: agentRow + 2, col: 11 }]
    : []
  return { panel: drawn, popups }
}

/**
 * The models an agent can start on, grouped by provider, narrowed by typing.
 * Opens under the field it belongs to, and may reach past the panel's edge.
 */
function modelList(panel: NewTaskPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = 48
  const inner = width - 2
  const query = panel.dropdown?.query ?? ''
  const found = matchingChoices(ctx.choices, query)
  const room = Math.max(4, Math.min(12, ctx.height - 16))
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(query, inner - 2, { caret: true })
      .build(),
  ]
  const current = panel.model ?? ctx.route?.model ?? null
  let group = ''
  let index = 0
  for (const choice of found) {
    if (rows.length >= room) break
    if (choice.group !== group) {
      group = choice.group
      rows.push(new Row(inner, skin).space().text(group.toUpperCase(), skin.label).build())
    }
    const on = index === (panel.dropdown?.index ?? 0)
    index++
    const target = { kind: 'control' as const, id: `choice:${choice.value}` }
    const r = new Row(inner, skin).text(on ? '▌' : ' ', skin.signal).space()
    r.text(choice.label, on ? skin.you : (t: string) => t, target)
    r.right((right) => {
      if (choice.note) right.text(choice.note, skin.hint).space()
      if (choice.value === current) right.text('✓', skin.done).space()
    })
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    })
  }
  if (found.length === 0) {
    rows.push(
      new Row(inner, skin)
        .space()
        .text(
          ctx.choices.length === 0
            ? 'No models found — sign in to a provider in pi.'
            : 'Nothing matches that.',
          skin.hint,
        )
        .build(),
    )
  }
  return box('', rows, width, skin, { corner: '▴' })
}
