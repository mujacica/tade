import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import type { Config } from '@tade/core'
import type { ExtensionHost, ExtensionWorkbench } from '@tade/extensions-core'
import type { HarnessModels } from '@tade/harnesses-core'
import type { Reporter } from '@tade/telemetry'
import type { Recorder, Transcriber } from '@tade/voice-core'
import type { Speaker } from '@tade/voice-tts'
import type { Workbench } from '@tade/workbench'
import type { Open } from '../editor.ts'
import type { Frame } from '../frame.ts'
import type { clipboardImage, clipboardState } from '../images.ts'
import type { LayoutPrefs } from '../layout.ts'
import type { Live } from '../live.ts'
import { type AppState, notice } from '../model.ts'
import type { McpServerShown } from '../panels/extensions/state.ts'
import type { MenuItem, MenuSubject, ThinkerOffers } from '../panels/menu/state.ts'
import type { PromptPanel } from '../panels/small/state.ts'
import type { Panel, PanelInputs } from '../panels.ts'
import type { ThinkerEvent } from '../transcript.ts'
import type { Hold } from './awake.ts'
import type { MachineNetwork } from './network.ts'

// What a subject of the window may reach, and nothing more.
//
// `app.ts` was twenty small objects sharing one `this`: of its 94 fields, 85
// were touched by six methods or fewer and clustered by subject exactly as the
// methods did. What every one of those subjects genuinely shares is five names
// — the options it was opened with, the state, the world as last looked at,
// the clock and the repaint — so that is what `Wiring` is, and a subject that
// wants more takes it as its own field or is handed it by `App`.
//
// The narrowness is the point: a subject cannot reach another subject's fields
// through it, which is what stops the file growing back. `Subject`, below, is
// the other half: what a subject offers back up, so the frame, the actions,
// the menus and the panels are folds over a list rather than five if-chains in
// one file that every feature had to be threaded through.

/**
 * Where free text goes: the orchestrator, seen from the window. Answers come
 * back from `ask`; everything it does on the way arrives through `onEvent`,
 * so the conversation can be watched rather than waited on.
 */
export interface Thinker {
  ask(text: string, images?: readonly WorkerImageFile[]): Promise<string>
  /** Tell it something without cutting across what it is doing: after its turn, if it is on one. */
  tell?(text: string): Promise<void>
  /**
   * How hard it thinks, from its next reply on. Its conversation carries on:
   * the level is asked of the process it is already in, never a restart.
   */
  setThinking?(level: string): Promise<void>
  /**
   * Stop the turn it is on. Not stopping it: the conversation, its session and
   * everything it has already said stay exactly as they are, and the next
   * thing you say carries on from there.
   */
  interrupt?(): Promise<void>
  /** What its harness can be asked of a turn in flight, in `offer()`'s words. */
  offers?: ThinkerOffers
  onEvent?(listener: (event: ThinkerEvent) => void): () => void
}

/** A picture to send with what you said: where it is, and what kind. */
export interface WorkerImageFile {
  path: string
  data: string
  mimeType: string
}

export interface AppOptions {
  client: Workbench
  config: Config
  /** The system clipboard's pictures: what is there, and saving it. The machine's own unless given. */
  clipboard?: {
    state: typeof clipboardState
    image: typeof clipboardImage
  }
  /**
   * How a file, a link or a folder is handed to the desktop — your editor,
   * your browser, your file manager. The machine's own unless given, for the
   * same reason `clipboard` is: a test suite may never reach the machine it
   * runs on, and one that opens Finder is worse than one that opens a socket.
   */
  open?: Open
  /**
   * How sleep is held off, for the same reason `open` and `clipboard` are
   * given: a suite may not ask the machine it runs on to stay awake, and could
   * assert nothing about it afterwards. The machine's `caffeinate` unless
   * given.
   */
  hold?: Hold
  /** Tade's state directory, where generated earcons are kept. */
  home: string
  cwd?: string
  terminal?: Terminal
  speaker?: Speaker
  /** Push-to-talk becomes speech when both of these are given. */
  transcriber?: Transcriber
  recorder?: Recorder
  /**
   * Where anything the grammar does not recognise goes. Without it, free text
   * gets "I didn't catch that", which is a poor answer to a real question.
   */
  thinker?: Thinker
  /**
   * What one harness offers to run, asked of that harness: never a list
   * gathered across them, because no harness could run one. The workbench
   * answers this unless something else is given.
   */
  models?: (harness: string) => Promise<HarnessModels>
  /** How each provider with credentials is paid for: signed in, or a key. */
  credentials?: () => Promise<Record<string, 'signed-in' | 'api-key' | 'env-key'>>
  /** The command that runs the harness interactively, for signing in. */
  signIn?: () => { command: string; args: string[] }
  /** The extensions this window runs with: their actions, their answers, their brief. */
  extensions?: ExtensionHost
  /** What the window lets an extension do: start an agent on something. */
  extensionWorkbench?: ExtensionWorkbench
  /**
   * Where Tade's own trouble goes. The window reports what it cannot show
   * you: a look at the tasks that took far longer than the time between two.
   */
  report?: Reporter
  /**
   * Start the orchestrator again, on what the config now says, carrying on its
   * conversation. Without it, a new model applies when Tade next starts.
   */
  restartThinker?: () => Promise<void>
  /** What the orchestrator could run on, as its own harness offers them, and nobody else's. */
  orchestratorModels?: () => Promise<HarnessModels>
  /**
   * Restart the window with the same arguments so changes can be tried live.
   * The callback should stop the app, release the home lock, and re-exec.
   */
  reloadWindow?: () => Promise<void>
  /**
   * The tools Tade wrote for itself, to list. Whether each is on is a
   * setting, which the window reads and writes like any other.
   */
  written?: () => { name: string; why: string; path: string }[]
  /** Extensions and servers each harness loads by itself, which Tade lists but does not run. */
  harnessExtensions?: () => Promise<{ name: string; where: string }[]>
  /**
   * The MCP servers Tade has been told about — the catalogue's among them,
   * all off until somebody says otherwise. Read again whenever the extensions
   * are, because turning one on is a setting like any other.
   */
  mcpServers?: (config: Config) => readonly McpServerShown[]
  /**
   * How the machine is asked whether it can reach a network at all — the one
   * thing that decides whether the watches look. The machine's own unless
   * given, for the reason `clipboard` is: a test suite may never reach the
   * network it runs on.
   */
  network?: MachineNetwork
  now?: () => number
  frameMs?: number
}

/**
 * Where the config is, which is one file under `home`.
 *
 * Here rather than with the settings subject because eight of the twenty
 * subjects write a setting of their own — muting, a model, an extension being
 * turned on — and a second `join(home, …)` anywhere is a second answer to
 * where Tade's config lives.
 */
export function configPathOf(opts: AppOptions): string {
  return join(opts.home, 'config.yaml')
}

/** The time of day something happened, the way news is said: `14:02`. */
export function clockOf(at: number): string {
  const time = new Date(at)
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

/** A moment as short as it can be said: the time today, or the day and time otherwise. */
export function whenShort(at: number, now: number): string {
  const time = new Date(at)
  const today = new Date(now)
  const clock = clockOf(at)
  const sameDay =
    time.getFullYear() === today.getFullYear() &&
    time.getMonth() === today.getMonth() &&
    time.getDate() === today.getDate()
  if (sameDay) return clock
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getDay()] ?? ''} ${clock}`
}

/**
 * A one-line panel that could not be carried out: the reason goes in the
 * panel, with everything typed still in it.
 */
export function promptFailed(wire: Wiring, panel: PromptPanel, error: string): void {
  wire.put({ ...wire.state, panel: { ...panel, busy: false, error } })
}

/** What went wrong, in words. The one reading of an unknown throw there is. */
export function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What every subject of the window may reach, and nothing more. */
/**
 * The last things the person themselves said, verbatim, newest among them.
 *
 * What a person typed or spoke is journalled as `said` and nothing else ever
 * writes there — so this is the one list in Tade that text an agent read can
 * never get into, which is what makes it worth checking against before acting
 * on somebody's behalf. Bounded because "they said it" has to mean lately.
 */
export async function saidLately(wire: Wiring, most: number): Promise<string[]> {
  const events = await wire.opts.client.events({ types: ['said'], limit: most }).catch(() => [])
  return events.flatMap((event) =>
    typeof event.detail.text === 'string' ? [event.detail.text] : [],
  )
}

export interface Wiring {
  /** What the window was opened with: the workbench, the config, the callbacks. */
  readonly opts: AppOptions
  /** The state as it is. */
  readonly state: AppState
  /** The only writer. A subject never assigns the state it was handed. */
  put(next: AppState): void
  /** The world as last looked at, or null before the first look. */
  readonly live: Live | null
  /** The clock, which is the window's and never a subject's own. */
  now(): number
  /**
   * When this window opened: the start of "This window" wherever it is offered.
   *
   * The window's own, so the Spend page and an extension's page mean the same
   * moment by it. Two subjects each reading the clock in their own constructor
   * would be two answers to one question, which is the shape of drift that
   * makes one page disagree with another about what happened this morning.
   *
   * A value rather than a call, unlike `now()`, because it is the one fact about
   * the window that cannot change while the window is open.
   */
  readonly openedAt: number
  /**
   * How the window is divided right now: the config's sizes, then the ones
   * dragged to, then how the bottom is shown.
   *
   * Here rather than in each subject's own `Deps` because it is derived from
   * what this object already carries — the options and the state — and more
   * than one subject needs it: what a lane is resized to, and where a divider
   * was dragged to. A callback each to one pure derivation is a chance for
   * them to be handed different ones.
   */
  layout(): LayoutPrefs
  /** Ask for a frame. */
  draw(): void
  /**
   * Say what went wrong in the strip: the `notice(state, why(err))` pattern,
   * written once. It does not draw — most callers are mid-flow and draw at the
   * end — so a caller that is finished asks for the frame itself.
   */
  note(err: unknown): void
}

/**
 * A subject of the window, as the hubs see it.
 *
 * Each of these is one flat table — the frame's fields, the panel's, an
 * action's name, a menu's kind, a panel's answer — and every one of them was
 * an if-chain in `app.ts` that every new feature added a branch to. Inverted,
 * the branch arrives in the subject that owns it and the hub never changes:
 * `frameOf` folds the first three, `Router` looks up the last four.
 *
 * All of them are optional, because most subjects answer two or three. A
 * subject that answers none of them is still a subject — it is simply one
 * nothing asks anything of from here.
 */
export interface Subject {
  /** Its slice of the frame, folded in by `frameOf`. */
  facts?(width: number): Partial<Frame>
  /** Its slice of what the open panel needs to draw. */
  panel?(width: number): Frame['panel']
  /** Its slice of what a panel needs to answer a key or a click. */
  inputs?(): PanelInputs
  /** The actions it answers, by name. */
  actions?(): Actions
  /** The menus it answers, by the kind of thing each is about. */
  menus?(): Menus
  /** The panels it carries out, by kind. */
  submits?(): Submits
  /** The one-line panels it carries out, by what each is for. */
  prompts?(): Prompts
}

/**
 * What an action does, by the name it is asked for.
 *
 * A name ending in `:` is a prefix and is handed whatever follows it —
 * `close-task:` answers `close-task:search/pagination` with `search/pagination`.
 * Anything else is the whole name, and is handed the empty string. The longest
 * matching prefix wins, so `queue-start:` and `queue-filter:` can both be in
 * the table without either shadowing the other.
 */
export type Actions = Record<string, (rest: string) => Promise<void> | void>

/** A menu's own words, its items, and what choosing one does. */
export type Menus = {
  [K in MenuSubject['kind']]?: {
    /** What the menu is called, over the thing it is about. */
    title(subject: Extract<MenuSubject, { kind: K }>): string
    /** Its items, from what is true of that thing now — never remembered. */
    items(subject: Extract<MenuSubject, { kind: K }>): readonly MenuItem[]
    /** What choosing one does. */
    choose(subject: Extract<MenuSubject, { kind: K }>, item: string): Promise<void> | void
  }
}

/** The same, with the subject as wide as the lookup can know it. */
export interface MenuKind {
  title(subject: MenuSubject): string
  items(subject: MenuSubject): readonly MenuItem[]
  choose(subject: MenuSubject, item: string): Promise<void> | void
}

/** Carrying a panel out: what it holds, and which of its buttons was pressed. */
export type Submits = {
  [K in Panel['kind']]?: (
    panel: Extract<Panel, { kind: K }>,
    choice: string | undefined,
  ) => Promise<void> | void
}

/** Carrying out a one-line panel, by what it is for. */
export type Prompts = Partial<
  Record<
    PromptPanel['purpose'],
    (panel: PromptPanel, text: string, choice: string | undefined) => Promise<void> | void
  >
>

/**
 * The first subject that answers for a kind of menu.
 *
 * Widened on the way out: a table keyed by kind cannot prove to the compiler
 * that the handler it found is the one for the subject in hand, and the key it
 * was registered under is what says so.
 */
export function menuOf(subjects: readonly Subject[], kind: MenuSubject['kind']): MenuKind | null {
  for (const subject of subjects) {
    const found = subject.menus?.()[kind]
    if (found) return found as MenuKind
  }
  return null
}

/** A path the way you would type it. */
export function tilde(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/**
 * Put something on the clipboard and say in the strip that it is there.
 *
 * Here rather than in a subject because three of them copy — a note, a path,
 * a selection dragged over the window — and what is said back has to be the
 * same sentence whichever did it.
 */
export async function copySaying(
  wire: Wiring,
  text: string,
  write: (data: string) => void,
): Promise<void> {
  const copied = await copyText(text, write)
  wire.put(notice(wire.state, copied ? `copied ${text}` : text))
  wire.draw()
}

/** The same for text dragged over: said as how much of it there was, never as itself. */
export async function copySpanSaying(
  wire: Wiring,
  text: string,
  write: (data: string) => void,
): Promise<void> {
  const copied = await copyText(text, write)
  const lines = text.split('\n').length
  wire.put(
    notice(
      wire.state,
      copied
        ? `copied ${lines > 1 ? `${lines} lines` : `${text.length} characters`}`
        : 'could not copy',
    ),
  )
  wire.draw()
}

/**
 * Put text on the clipboard. The system's own tool where there is one, since
 * Terminal.app ignores the escape sequence; the sequence everywhere else.
 */
export async function copyText(text: string, write: (data: string) => void): Promise<boolean> {
  const tool =
    process.platform === 'darwin'
      ? ['pbcopy']
      : process.env.WAYLAND_DISPLAY
        ? ['wl-copy']
        : process.env.DISPLAY
          ? ['xclip', '-selection', 'clipboard']
          : null
  if (tool) {
    const copied = await new Promise<boolean>((resolve) => {
      const child = spawn(tool[0] as string, tool.slice(1), {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
      // A clipboard tool that exits before it reads leaves us writing to a
      // closed pipe, and an unhandled 'error' on a stream takes the window
      // down. Whether it copied is its exit code's to say.
      child.stdin?.on('error', () => {})
      child.stdin?.end(text)
    })
    if (copied) return true
  }
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  return true
}
