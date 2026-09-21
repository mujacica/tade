import { join } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import type { Config } from '@tade/core'
import type { ExtensionHost, ExtensionWorkbench } from '@tade/extensions-core'
import type { Reporter } from '@tade/telemetry'
import type { Recorder, Transcriber } from '@tade/voice-core'
import type { Speaker } from '@tade/voice-tts'
import type { Workbench } from '@tade/workbench'
import type { clipboardImage, clipboardState } from '../images.ts'
import type { Live } from '../live.ts'
import type { AppState } from '../model.ts'
import type { McpServerShown } from '../panels/extensions/state.ts'
import type { ThinkerOffers } from '../panels/menu/state.ts'
import type { ModelChoice } from '../panels/models/state.ts'
import type { ThinkerEvent } from '../transcript.ts'

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
// through it, which is what stops the file growing back. Slice 9 of
// `docs/modularity.md` folds `facts()`/`panel()`/`inputs()` over the subjects
// that this interface makes possible; until then `App` calls them by hand.

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
   * The models an agent can be started on, from the harness's own catalog.
   * Passed in, so the window does not have to know which harness it is.
   */
  models?: () => Promise<{ id: string; provider: string; name: string }[]>
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
  /** What the orchestrator could run on, as its own harness offers them. */
  orchestratorModels?: () => Promise<ModelChoice[]>
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

/** What went wrong, in words. The one reading of an unknown throw there is. */
export function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What every subject of the window may reach, and nothing more. */
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
  /** Ask for a frame. */
  draw(): void
  /**
   * Say what went wrong in the strip: the `notice(state, why(err))` pattern,
   * written once. It does not draw — most callers are mid-flow and draw at the
   * end — so a caller that is finished asks for the frame itself.
   */
  note(err: unknown): void
}
