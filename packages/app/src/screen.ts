import {
  type Component,
  ProcessTerminal,
  type Terminal,
  TuiAltScreen,
  type TuiInputListenerResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { LaneId } from '@tade/core'
import { PtyDriver } from '@tade/drivers-pty'
import { type Hit, hitAt } from './hits.ts'
import { COLOUR as COLOUR_SKIN, PLAIN as PLAIN_SKIN, type Skin } from './skin.ts'
import { blank, box, type Drawn, Row, stack } from './ui.ts'

// A screen for the things Tade asks you: setting up, and changing settings.
//
// Both used to be printed — a scroll of prompts, and for setup, other people's
// programs handed the terminal with `stdio: 'inherit'` while a readline was
// still reading it. Two readers of one keyboard is why Enter sometimes did
// nothing and characters vanished.
//
// So the terminal belongs to Tade throughout. Anything it has to run goes in
// a lane, exactly as an agent does, and its screen is drawn inside this one.
// That is the claim the rest of Tade makes — a window over things running
// somewhere else — applied to the last place that was still shelling out.

/**
 * How the screen is coloured.
 *
 * A function per role rather than a table of codes, so the plain palette is
 * the identity function and everything downstream stays a string. Colour is
 * decoration: every screen has to read correctly without it, because plenty of
 * terminals, pipes and CI logs will never show it.
 */
export interface Palette {
  title(text: string): string
  rule(text: string): string
  done(text: string): string
  todo(text: string): string
  optional(text: string): string
  cursor(text: string): string
  hint(text: string): string
  said(text: string): string
}

const plain = (text: string) => text
export const PLAIN: Palette = {
  title: plain,
  rule: plain,
  done: plain,
  todo: plain,
  optional: plain,
  cursor: plain,
  hint: plain,
  said: plain,
}

const paint = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
const COLOUR: Palette = {
  title: paint('1;36'),
  rule: paint('2;36'),
  done: paint('32'),
  todo: paint('33'),
  optional: paint('2'),
  cursor: paint('1;36'),
  hint: paint('2'),
  said: paint('2'),
}

/**
 * Colour, where the terminal is one that shows it.
 *
 * `NO_COLOR` is honoured because people who set it mean it, and a `dumb`
 * terminal or a pipe gets nothing: escape codes in a log file are worse than
 * plain text, and this is the one decision that cannot be made from inside the
 * renderer, which is pure.
 */
export function paletteFor(env: NodeJS.ProcessEnv = process.env, tty = true): Palette {
  if (!tty) return PLAIN
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return PLAIN
  if (env.TERM === 'dumb' || !env.TERM) return PLAIN
  return COLOUR
}

export interface Prompt {
  question: string
  /** Shown in brackets and used when the answer is empty. */
  fallback: string
  /** Answers are yes/no rather than free text. */
  confirm: boolean
}

export interface Menu {
  question: string
  options: readonly string[]
  /** Which of the *matching* options is under the cursor. */
  index: number
  /** What has been typed to narrow the list. */
  filter: string
}

/** The options that match what has been typed, in order, with their places. */
export function matching(menu: Menu): Array<{ option: string; at: number }> {
  const want = menu.filter.trim().toLowerCase()
  const all = menu.options.map((option, at) => ({ option, at }))
  if (want === '') return all
  // Every word has to appear somewhere, in any order: people type "opus 5"
  // for "anthropic/claude-opus-5" and mean it.
  const words = want.split(/\s+/)
  return all.filter(({ option }) => {
    const haystack = option.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

export interface ScreenState {
  /** What this screen is for, shown beside the banner. */
  title: string
  /** Standing context: a checklist, a file path, whatever is always true. */
  context: readonly string[]
  /** What has happened so far, oldest first. */
  said: readonly string[]
  prompt: Prompt | null
  menu: Menu | null
  /** What has been typed at the prompt. */
  typed: string
  /** An embedded terminal, when something is running inside the window. */
  running: { title: string; screen: string } | null
  finished: string
}

export function initialScreen(title: string, context: readonly string[] = []): ScreenState {
  return {
    title,
    context,
    said: [],
    prompt: null,
    menu: null,
    typed: '',
    running: null,
    finished: '',
  }
}

/** Tade is stopped the way every terminal program is: ctrl+c. */
export class ScreenCancelled extends Error {
  readonly code = 'SCREEN_CANCELLED'
  constructor() {
    super('stopped')
    this.name = 'ScreenCancelled'
  }
}

/**
 * The whole screen, one string per row.
 *
 * Laid out as the first-run screen was designed: the wordmark, steps down the
 * left when there are steps, and one question at a time in a panel on the
 * right — with a program that has to run, like pi's sign-in, drawn inside that
 * panel rather than handed the terminal.
 *
 * Pure: state in, rows out.
 */
export function renderScreen(
  state: ScreenState,
  frame: { width: number; height: number; palette?: Palette },
): string[] {
  return drawScreen(state, frame).rows
}

/** The wordmark, in half blocks: curves in five rows rather than a wall of them. */
const WORDMARK_LETTERS: Record<string, string[]> = {
  T: ['████████', '   ██   ', '   ██   ', '   ██   ', '   ██   '],
  A: [' ▄████▄ ', '██▀  ▀██', '████████', '██    ██', '██    ██'],
  D: ['██████▄ ', '██   ▀██', '██    ██', '██   ▄██', '██████▀ '],
  E: ['████████', '██      ', '██████  ', '██      ', '████████'],
}
export const WORDMARK = [0, 1, 2, 3, 4].map((i) =>
  [...'TADE'].map((letter) => WORDMARK_LETTERS[letter]?.[i] ?? '').join('  '),
)
/** Five steps of the brand colour, light at the top: an amber terminal, warm at the crown. */
const SHADES = [223, 221, 214, 208, 166]
/** Below this the wordmark is taking room the questions need. */
const ROOM_FOR_WORDMARK = { width: 60, height: 24 }

interface Step {
  mark: string
  title: string
  detail: string
}

/** A checklist line — `✓ A project — checkout` — or null for any other context. */
function stepOf(line: string): Step | null {
  const text = line.trim()
  const mark = text.slice(0, 1)
  if (!['✓', '·', '○', '▸'].includes(mark)) return null
  const [title, ...detail] = text.slice(1).trim().split(' — ')
  return { mark, title: title ?? '', detail: detail.join(' — ') }
}

export function drawScreen(
  state: ScreenState,
  frame: { width: number; height: number; palette?: Palette },
): Drawn {
  const width = Math.max(30, frame.width)
  const height = Math.max(10, frame.height)
  const skin: Skin = (frame.palette ?? PLAIN) === PLAIN ? PLAIN_SKIN : COLOUR_SKIN
  const rows: { text: string; hits: Hit[] }[] = []

  // ── the wordmark, or its name where there is no room for it ──
  const tagline = new Row(width, skin).space(4).text('said, and done.', skin.you).space()
  tagline.text(
    state.title === 'Setting up'
      ? 'A control room for the coding agents on this machine.'
      : state.title,
    skin.hint,
  )
  if (width >= ROOM_FOR_WORDMARK.width && height >= ROOM_FOR_WORDMARK.height) {
    rows.push(blank(width))
    WORDMARK.forEach((line, i) => {
      const shade = SHADES[i] ?? 80
      const painted = skin.colour ? `\x1b[38;5;${shade}m${line}\x1b[0m` : line
      rows.push({ text: fitScreen(`    ${painted}`, width), hits: [] })
    })
    rows.push(blank(width))
    rows.push(tagline.build())
  } else {
    rows.push(new Row(width, skin).space().mark('TADE').text(` ${state.title}`, skin.hint).build())
  }
  rows.push(blank(width))

  // ── the steps, and the question beside them ──
  const steps = state.context.map(stepOf)
  const checklist =
    steps.every((step) => step !== null) && steps.length > 0 ? (steps as Step[]) : null
  const current = checklist
    ? checklist.findIndex((step) => step.mark === '·' || step.mark === '▸')
    : -1
  const room = Math.max(4, height - rows.length - 2)
  const side = checklist && width >= 90 ? 28 : 0
  const panelWidth = Math.min(width - side - 4, 84)

  const left: { text: string; hits: Hit[] }[] = []
  if (side > 0 && checklist) {
    left.push({ text: skin.edge(`╭─ SET UP ${'─'.repeat(side - 11)}╮`), hits: [] })
    checklist.forEach((step, i) => {
      const on = i === current
      const mark = on ? skin.signal('▸') : step.mark === '✓' ? skin.done('✓') : skin.hint(step.mark)
      const r = new Row(side - 2, skin)
        .space()
        .text(mark)
        .space()
        .text(step.title, on ? skin.you : step.mark === '✓' ? (t: string) => t : skin.hint)
      if (step.detail) r.right((right) => right.text(shorten(step.detail, 12), skin.hint).space())
      const built = r.build()
      left.push({
        text: `${skin.edge('│')}${on ? skin.selected(built.text) : built.text}${skin.edge('│')}`,
        hits: [],
      })
    })
    left.push({ text: skin.edge(`╰${'─'.repeat(side - 2)}╯`), hits: [] })
  }

  const panel = drawQuestion(state, panelWidth, room, skin, checklist, current, side === 0)
  const lines = Math.min(room, Math.max(left.length, panel.rows.length))
  for (let i = 0; i < lines; i++) {
    const l = side > 0 ? fitScreen(left[i]?.text ?? '', side) : ''
    const r = panel.rows[i] ?? ''
    const offset = 2 + (side > 0 ? side + 2 : 0)
    rows.push({
      text: fitScreen(`  ${l}${side > 0 ? '  ' : ''}${r}`, width),
      hits: panel.hits
        .filter((hit) => hit.row === i)
        .map((hit) => ({ ...hit, row: 0, from: hit.from + offset, to: hit.to + offset })),
    })
  }
  while (rows.length < height - 2) rows.push(blank(width))

  // ── the keys ──
  rows.push({ text: skin.chrome('─'.repeat(width)), hits: [] })
  rows.push(
    new Row(width, skin)
      .space()
      .text(keys(state), skin.hint)
      .right((r) => r.text('ctrl+c quits — what you answered is saved', skin.hint).space())
      .build(),
  )
  // Clamped to what the terminal actually has, not to the minimum this layout
  // wants: drawing one row more than there is scrolls the screen out from
  // under itself, and a cramped window is somebody's split pane, not a bug.
  return stack(rows.slice(0, frame.height))
}

/** The question being asked, in its panel: a list, a field, or a program running. */
function drawQuestion(
  state: ScreenState,
  width: number,
  room: number,
  skin: Skin,
  checklist: Step[] | null,
  current: number,
  contextInside: boolean,
): Drawn {
  const inner = width - 2
  const row = () => new Row(inner, skin)
  const body: { text: string; hits: Hit[] }[] = []

  // With no room for the steps beside the panel, they go inside it.
  if (contextInside) {
    for (const line of state.context) {
      const step = stepOf(line)
      const tone = step?.mark === '✓' ? skin.done : step ? skin.hint : skin.hint
      body.push(row().space().text(line.trim(), tone).build())
    }
    if (state.context.length > 0) body.push(blank(inner))
  }
  for (const said of state.said) body.push(row().space().text(said.trim(), skin.hint).build())
  if (state.said.length > 0) body.push(blank(inner))

  let title = state.title
  if (state.running) {
    title = state.running.title
    const screenRows = Math.max(3, room - body.length - 6)
    const termWidth = inner - 2
    body.push(
      row()
        .space()
        .text(
          `┌─ ${state.running.title} ${'─'.repeat(Math.max(0, termWidth - 5 - state.running.title.length))}┐`,
          skin.chrome,
        )
        .build(),
    )
    const lines = state.running.screen.split('\n')
    const shown = lines.slice(Math.max(0, lines.length - screenRows))
    while (shown.length < screenRows) shown.push('')
    for (const line of shown) {
      body.push({
        text: ` ${skin.chrome('│')}${fitScreen(line, termWidth - 2)}${skin.chrome('│')}`,
        hits: [],
      })
    }
    const back = ' ctrl+] back to Tade '
    body.push(
      row()
        .space()
        .text(`└${'─'.repeat(Math.max(0, termWidth - 3 - back.length))}${back}─┘`, skin.chrome)
        .build(),
    )
  } else if (state.menu) {
    const menu = state.menu
    title = menu.question
    const found = matching(menu)
    // A short list is read, not searched: the field only earns its row on a long one.
    if (menu.options.length > 6 || menu.filter !== '') {
      body.push(
        row()
          .space()
          .field(menu.filter, Math.min(inner - 2, 40), { caret: true, hint: menu.filter === '' })
          .right((r) => r.text(menu.filter === '' ? 'type to narrow' : '', skin.hint).space())
          .build(),
      )
    }
    body.push(blank(inner))
    if (found.length === 0)
      body.push(row().space(3).text('nothing matches that', skin.hint).build())
    // A window around the cursor, so a long list neither overflows the screen
    // nor scrolls the thing you are pointing at out of sight.
    const space = Math.max(1, room - body.length - 5)
    const first = Math.max(0, Math.min(menu.index - Math.floor(space / 2), found.length - space))
    // Descriptions line up in a column, so the names read down the left.
    const labelWidth = Math.max(
      ...found.map(({ option }) => visibleWidth(option.split(' — ')[0] ?? option)),
      0,
    )
    found.slice(first, first + space).forEach(({ option }, i) => {
      const here = first + i === menu.index
      const [label, ...more] = option.split(' — ')
      const target = { kind: 'control' as const, id: `option:${first + i}` }
      const r = row()
        .space()
        .text(here ? '◉' : '○', here ? skin.signal : skin.hint)
        .space()
      const name = label ?? option
      r.text(name, here ? skin.you : (t: string) => t)
      if (more.length > 0)
        r.space(labelWidth - visibleWidth(name) + 3).text(more.join(' — '), skin.hint)
      const built = r.build()
      body.push({ text: built.text, hits: [{ row: 0, from: 0, to: inner - 1, target }] })
    })
  } else if (state.prompt) {
    const prompt = state.prompt
    title = prompt.question
    if (prompt.confirm) {
      const yes = prompt.fallback === 'y'
      body.push(
        row()
          .space()
          .text(`${prompt.question} [${yes ? 'Y/n' : 'y/N'}]`, skin.you)
          .build(),
      )
      body.push(blank(inner))
      body.push(
        row()
          .space()
          .button('Yes', { kind: 'control', id: 'answer:y' }, yes ? 'primary' : 'rest')
          .space()
          .button('No', { kind: 'control', id: 'answer:n' }, yes ? 'rest' : 'primary')
          .build(),
      )
    } else {
      const shown = `${prompt.question}${prompt.fallback.trim() ? ` [${prompt.fallback}]` : ''}: ${state.typed}`
      body.push(row().space().text(shown, skin.you).build())
      body.push(
        row()
          .space()
          .field(state.typed || prompt.fallback.trim(), Math.min(inner - 2, 60), {
            caret: true,
            hint: state.typed === '',
          })
          .build(),
      )
    }
  }
  if (state.finished) body.push(row().space().text(state.finished, skin.done).build())

  body.push(blank(inner))
  if (state.menu || (state.prompt && !state.prompt.confirm)) {
    body.push(
      row()
        .right((r) =>
          r.button('Continue ⏎', { kind: 'control', id: 'continue' }, 'primary').space(),
        )
        .build(),
    )
  }

  const corner = checklist && current >= 0 ? `step ${current + 1} of ${checklist.length}` : ''
  return box(title, body.slice(0, Math.max(1, room - 2)), width, skin, corner ? { corner } : {})
}

function shorten(text: string, size: number): string {
  return [...text].length > size ? `${[...text].slice(0, size - 1).join('')}…` : text
}

function fitScreen(text: string, width: number): string {
  const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, '') : text
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
}

function keys(state: ScreenState): string {
  if (state.running) return 'ctrl+] back to Tade'
  if (state.menu) return '↑↓ choose · enter continue'
  if (state.prompt) return 'enter continues, or takes the suggestion'
  return ''
}

/** What a flow can do to the screen. */
export interface Ui {
  /** Put a line in the transcript. */
  say(text: string): void
  /** Replace the standing context above the question. */
  context(lines: readonly string[]): void
  ask(question: string, fallback?: string): Promise<string>
  confirm(question: string, fallback: boolean): Promise<boolean>
  /** Pick one of several. Returns the index. */
  choose(question: string, options: readonly string[]): Promise<number>
  /**
   * Say something and wait to be told it has been read. For anything that went
   * wrong: a screen that closes on the way out takes the explanation with it.
   */
  pause(text: string): Promise<void>
  /**
   * Run something in a terminal inside the window, and wait for it. Every
   * keystroke goes to it while it runs, because Tade is the only thing
   * reading the keyboard.
   */
  run(title: string, command: string, args: string[]): Promise<number>
}

export interface ScreenOptions {
  title: string
  context?: readonly string[]
  /** Injected by tests; the real terminal otherwise. */
  terminal?: Terminal
  driver?: PtyDriver
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** How often an embedded terminal is re-read. */
  frameMs?: number
  /** Defaults to colour where the terminal shows it. */
  palette?: Palette
}

/** ctrl+] — the way out of an embedded program, as telnet has always had it. */
const LEAVE = '\x1d'
const INTERRUPT = '\x03'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

/**
 * Draw the screen and run `flow` against it.
 *
 * The screen lives as long as the flow does, and the terminal is restored on
 * every path out — ctrl+c and a thrown error included. Leaving somebody in the
 * alternate screen because something failed is a worse outcome than whatever
 * failed.
 */
export async function runScreen(
  opts: ScreenOptions,
  flow: (ui: Ui) => Promise<void>,
): Promise<void> {
  const terminal = opts.terminal ?? new ProcessTerminal()
  const driver = opts.driver ?? new PtyDriver({ scrollback: 2_000 })
  const tui = new TuiAltScreen(terminal)
  let state = initialScreen(opts.title, opts.context ?? [])

  const draw = () => tui.requestRender()
  const palette = opts.palette ?? paletteFor(opts.env ?? process.env, true)
  tui.addChild(
    new Screen(
      () => ({ state, height: Math.max(10, terminal.rows), palette }),
      (id) => clicked(id),
    ),
  )

  /** Whoever is waiting on a keystroke right now. */
  let answer: ((text: string) => void) | null = null
  let lane: LaneId | null = null
  let running = 0

  /** Settles if ctrl+c is pressed, so every wait can race against it. */
  let cancel: (() => void) | null = null
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new ScreenCancelled())
  })
  // Nobody may be waiting when ctrl+c arrives, and an unhandled rejection
  // would take the process down with a stack trace instead of a sentence.
  cancelled.catch(() => {})

  const release = tui.addInputListener((data: string): TuiInputListenerResult => {
    if (data.includes(INTERRUPT)) {
      if (lane) void driver.close(lane).catch(() => {})
      cancel?.()
      return { consume: true }
    }
    if (lane) {
      if (data.includes(LEAVE)) {
        void driver.close(lane).catch(() => {})
        return { consume: true }
      }
      void driver.write(lane, new TextEncoder().encode(data)).catch(() => {})
      return { consume: true }
    }
    if (state.menu) {
      const menu = state.menu
      const found = matching(menu)
      const settle = (index: number) => {
        const chosen = answer
        answer = null
        state = { ...state, menu: null }
        // The place in the list the caller gave us, not the place in what is
        // left of it after narrowing.
        chosen?.(String(index))
      }
      if (data === UP) {
        state = { ...state, menu: { ...menu, index: Math.max(0, menu.index - 1) } }
      } else if (data === DOWN) {
        state = { ...state, menu: { ...menu, index: Math.min(found.length - 1, menu.index + 1) } }
      } else if (data === '\r' || data === '\n') {
        const picked = found[menu.index]
        if (picked) settle(picked.at)
      } else if (data === '\x7f' || data === '\b') {
        state = { ...state, menu: { ...menu, filter: menu.filter.slice(0, -1), index: 0 } }
      } else if (data >= ' ' && data.length === 1) {
        // Typing narrows the list rather than jumping to a number: a list
        // worth searching is longer than nine things.
        state = { ...state, menu: { ...menu, filter: menu.filter + data, index: 0 } }
      }
      draw()
      return { consume: true }
    }
    if (!answer) return { consume: true }
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const text = state.typed
        state = { ...state, typed: '' }
        const settle = answer
        answer = null
        settle(text)
        break
      }
      if (char === '\x7f' || char === '\b') {
        state = { ...state, typed: state.typed.slice(0, -1) }
        continue
      }
      // Control characters are not answers: ignore rather than paint them.
      if (char >= ' ') state = { ...state, typed: state.typed + char }
    }
    draw()
    return { consume: true }
  })

  /** A click is the same answer the keyboard would have given. */
  const clicked = (id: string) => {
    if (lane || !answer) return
    const menu = state.menu
    if (menu && id.startsWith('option:')) {
      const found = matching(menu)
      const index = Number(id.slice('option:'.length))
      const picked = found[index]
      if (!picked) return
      const settle = answer
      answer = null
      state = { ...state, menu: null }
      settle(String(picked.at))
    } else if (menu && id === 'continue') {
      const picked = matching(menu)[menu.index]
      if (!picked) return
      const settle = answer
      answer = null
      state = { ...state, menu: null }
      settle(String(picked.at))
    } else if (state.prompt && (id === 'continue' || id.startsWith('answer:'))) {
      const text = id.startsWith('answer:') ? id.slice('answer:'.length) : state.typed
      const settle = answer
      answer = null
      state = { ...state, typed: '' }
      settle(text)
    }
    draw()
  }

  tui.start()
  draw()

  /** Wait for an answer, or for ctrl+c, whichever comes first. */
  const waitFor = (): Promise<string> =>
    Promise.race([
      new Promise<string>((resolve) => {
        answer = resolve
      }),
      cancelled,
    ])

  const ui: Ui = {
    say(text) {
      state = { ...state, said: [...state.said, text] }
      draw()
    },
    context(lines) {
      state = { ...state, context: lines }
      draw()
    },
    async ask(question, fallback = '') {
      state = { ...state, prompt: { question, fallback, confirm: false }, typed: '' }
      draw()
      const said = await waitFor()
      state = { ...state, prompt: null }
      draw()
      return said.trim() || fallback
    },
    async confirm(question, fallback) {
      const prompt = { question, fallback: fallback ? 'y' : 'n', confirm: true }
      state = { ...state, prompt, typed: '' }
      draw()
      const said = (await waitFor()).trim().toLowerCase()
      state = { ...state, prompt: null }
      draw()
      return said === '' ? fallback : said.startsWith('y')
    },
    async pause(text) {
      state = { ...state, said: [...state.said, text] }
      await ui.ask('press enter to go back', ' ')
    },
    async choose(question, options) {
      state = { ...state, menu: { question, options, index: 0, filter: '' } }
      draw()
      const picked = Number(await waitFor())
      state = { ...state, menu: null }
      draw()
      return Number.isInteger(picked) ? picked : 0
    },
    async run(title, command, args) {
      const id = `screen/${++running}` as LaneId
      const rows = Math.max(8, terminal.rows - state.context.length - 14)
      await driver.open({
        id,
        cwd: opts.cwd ?? process.cwd(),
        command,
        args,
        cols: Math.max(40, terminal.columns - 4),
        rows,
        ...(opts.env ? { env: stringly(opts.env) } : {}),
      })
      lane = id
      state = { ...state, running: { title, screen: '' } }

      const show = async () => {
        const screen = await driver.capture(id, { lines: rows }).catch(() => '')
        state = { ...state, running: { title, screen } }
        draw()
      }
      // Polled as well as pushed. A capture taken the instant output arrives
      // can beat the emulator to rendering it, and a program that prints once
      // and then waits — which is every login prompt — would leave the screen
      // blank forever with nothing to trigger a second look.
      const stopOutput = driver.onOutput(id, () => void show())
      const ticking = setInterval(() => void show(), opts.frameMs ?? 80)
      ticking.unref?.()
      try {
        return await Promise.race([
          new Promise<number>((resolve) => {
            driver.onExit(id, (exit: { code: number | null }) => resolve(exit.code ?? 0))
          }),
          cancelled,
        ])
      } finally {
        clearInterval(ticking)
        stopOutput()
        lane = null
        state = { ...state, running: null }
        draw()
      }
    },
  }

  try {
    await Promise.race([flow(ui), cancelled])
    state = { ...state, finished: 'Done.' }
    draw()
  } finally {
    release()
    await driver.shutdown().catch(() => {})
    tui.stop()
    // Nothing of the screen is left behind: what somebody sees after it closes
    // is their own terminal, not the bottom half of a form.
    terminal.clearScreen()
  }
}

/** node-pty rejects anything that is not a string, which test runners inject. */
function stringly(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

class Screen implements Component {
  private readonly frame: () => { state: ScreenState; height: number; palette: Palette }
  private readonly onClick: (id: string) => void
  private hits: readonly Hit[] = []

  constructor(frame: Screen['frame'], onClick: (id: string) => void) {
    this.frame = frame
    this.onClick = onClick
  }

  render(width: number): string[] {
    const { state, height, palette } = this.frame()
    const drawn = drawScreen(state, { width, height, palette })
    this.hits = drawn.hits
    return drawn.rows
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined
    const target = hitAt(this.hits, event.x, event.y)
    if (target?.kind !== 'control') return undefined
    this.onClick(target.id)
    return { handled: true }
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
}
