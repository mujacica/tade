// The TadeExtension port: something Tade can do that it was not built
// knowing about — check a project's dependencies, read its errors in Sentry.
//
// An extension is harness-neutral. It declares tools as plain JSON Schema and
// runs them in the window's own process, and each harness is handed them in
// its own terms: pi as registered tools that call back to Tade, a harness
// that speaks MCP as a server. What only a harness can do — a pi skill, a pi
// extension with its own UI — an extension ships alongside, by harness id, and
// it is loaded there as the harness's own. Nothing here names a harness's
// private vocabulary except those keys.

/** A JSON Schema object, which is what every harness's tool parameters are underneath. */
export type JsonSchema = Record<string, unknown>

/** Somewhere a result points: an issue, a trace, a changelog. Clickable wherever it is shown. */
export interface Link {
  title: string
  url: string
}

/** A project Tade has been told about. */
export interface ProjectRef {
  name: string
  /** Absolute. */
  root: string
  /** How its work is checked, when the config says. */
  test?: string
}

/** Who asked for a tool: the orchestrator, an agent working somewhere, or you, from the window. */
export type Caller =
  | { kind: 'orchestrator' }
  | { kind: 'agent'; task: string; project: string; cwd: string }
  | { kind: 'you' }

/** Who a tool is offered to. */
export type Audience = 'orchestrator' | 'agent'

/** One setting an extension reads from `extensions.<name>` in the config. */
export interface ExtensionSetting {
  key: string
  /** What it means, in a sentence: shown wherever the setting is. */
  means: string
  kind: 'string' | 'boolean' | 'number' | 'list' | 'map'
}

/** What a tool answers: words for whoever asked, and where they point. */
export interface ToolAnswer {
  /** Markdown, for a model or a person to read. */
  text: string
  /** The answer in a sentence, for saying out loud; the first line of the text when not given. */
  said?: string
  links?: readonly Link[]
  /** The same answer as data, for a caller that is a program. */
  data?: unknown
}

export interface ExtensionTool {
  /** Starts with the extension's name and an underscore: `sentry_issues`. */
  name: string
  /** Written for the model that chooses it: when to use it, and what comes back. */
  description: string
  parameters: JsonSchema
  /** Who may call it. */
  for: readonly Audience[]
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolAnswer>
}

/** A button in the window, a line in ctrl+k, a `tade extensions run`: one tool with its input. */
export interface ExtensionAction {
  id: string
  /** What it does, as a button says it: "Check dependencies". */
  title: string
  tool: string
  input?: Record<string, unknown>
  /** It works on a project, which is the one you are in. */
  project?: boolean
  /**
   * What someone says to run it straight away, matched against the whole
   * utterance: "how much is Tade using". Heard this way it needs no model,
   * so keep them narrow — anything looser belongs to the orchestrator.
   */
  heard?: readonly RegExp[]
}

/** One thing worth hearing in the brief, and what to ask about it. */
export interface BriefItem {
  /** A clause, said as part of a sentence: "Sentry has 3 new issues in checkout". */
  said: string
  /** What to ask the orchestrator, offered as a suggestion: "Look at them and say which to fix". */
  ask?: string
  links?: readonly Link[]
}

/** Something on screen an extension knows how to open: a Sentry short id, say. */
export interface Linker {
  /** A regular expression, as source; every match is a link. */
  pattern: string
  /** The address, with `$&` for what matched. */
  url: string
}

/** What harness-native pieces go along with an extension, by harness id. */
export interface HarnessPieces {
  /** Native extension modules, relative to the extension's folder. */
  extensions?: readonly string[]
  /** Skill folders or files, relative to the extension's folder. */
  skills?: readonly string[]
}

/** One thing to fill in while setting an extension up: a key under `extensions.<name>`. */
export interface SetupField {
  key: string
  label: string
  /** A sentence under the field: what it is for, where to find it. */
  help?: string
  placeholder?: string
  /**
   * `text` is one value; `list` is values separated by commas; `map` is
   * `name=value` pairs separated by commas, like which Sentry project each of
   * yours reports to; `flag` is on or off.
   */
  kind: 'text' | 'list' | 'map' | 'flag'
  /** Values to offer, looked up when asked: the organizations a token can see. */
  choices?(ctx: ExtensionContext): Promise<readonly string[]>
}

/**
 * How to set an extension up, in the window: what it needs in words, the
 * settings to fill in, and where to go for what cannot be filled in here — a
 * token is never typed into Tade, which would put it in a file.
 */
export interface ExtensionSetup {
  /** Steps, in markdown, in the order to take them. */
  guide: readonly string[]
  fields?: readonly SetupField[]
  links?: readonly Link[]
}

/** Something a watch found: what it is, and a key that stays the same every time it is found. */
export interface Finding {
  key: string
  title: string
  /** More about it, for the agent that starts on it: written into its context. */
  detail?: string
  links?: readonly Link[]
}

/** What a watch looks with. */
export interface WatchContext extends ExtensionContext {
  /** The project it watches. */
  watching: ProjectRef
  /** What it was turned on with. */
  input: Readonly<Record<string, unknown>>
  /** Where its last look left off, as that look said; null the first time. */
  since: string | null
  /** When it was turned on, as an ISO time: what was already there then is not new. */
  turnedOn: string
  signal: AbortSignal
}

/** An agent on one finding: what its task is called, what it is told, and what it reads first. */
export interface WatchAgent {
  title: string
  prompt: string
  context?: string
  links?: readonly Link[]
}

/**
 * Work an extension can watch for: a cheap look, on a clock, at whether there
 * is anything to do — and what an agent is told about each thing it finds.
 *
 * Nothing is watched until someone turns it on, which makes it a schedule like
 * any other: paused, renamed or removed the same way. Tade keeps where each
 * look left off and every key it has found, so a watch keeps nothing itself and
 * one finding never starts two agents.
 */
export interface ExtensionWatch {
  /** Its name in the extension: `new-errors`. Turned on, it is `<extension>.<id>`. */
  id: string
  title: string
  /** What it looks for and what it starts, in a sentence. */
  means: string
  /** How often it looks unless told otherwise, as a schedule says it: `30m`, `1h`, `1d`. */
  every: string
  /** What it can be turned on with, as a tool's parameters are said. Checked before it is. */
  input?: JsonSchema
  /**
   * Look, and say what there is. No model: it runs on a clock, and a look that
   * finds nothing costs nothing. Nothing found is an empty list, never a throw;
   * it throws, with why, only when it cannot look at all. What it returns as
   * `since` is handed to its next look, which may find some of the same things
   * again: Tade knows which it has seen.
   */
  check(ctx: WatchContext): Promise<{ found: readonly Finding[]; since?: string }>
  /**
   * What an agent starting on one finding is told. Asked only for what work is
   * started on, so this is where anything slow to fetch about a finding belongs.
   */
  agent(finding: Finding, ctx: WatchContext): Promise<WatchAgent> | WatchAgent
}

/** What an open window can do for an extension that nothing else can. */
export interface ExtensionWorkbench {
  /**
   * Put an agent to work on something — in the project's checkout or a
   * worktree of its own, as the person has Tade set up: the context written
   * where it will read it, the links kept with the task, and `prepare` given
   * the directory it will work in before it starts, for changes it should
   * begin from.
   */
  startAgent(request: {
    project: string
    title: string
    prompt: string
    context?: string
    links?: readonly Link[]
    prepare?: (worktree: string) => Promise<void>
    /** Who asked for it. Filled in by Tade with the extension's name; an extension's own is replaced. */
    by?: string
  }): Promise<{ task: string; worktree: string }>
  /** Tade's own process: the window. */
  readonly pid: number
  /** What Tade is running: every lane, with the task it belongs to and its process. */
  lanes(): readonly { id: string; task: string; kind: string; pid: number | null; alive: boolean }[]
}

/**
 * A row an extension keeps in the window: what it is, how it is going, and
 * where clicking it goes. The window draws it and knows nothing else about
 * it — which is what keeps the sidebar from having to learn what a forge is.
 */
export interface ListRow {
  /** Stable, so the cursor stays on the same row across polls. */
  id: string
  title: string
  /** A few words to the right: a repository, a branch, a time. */
  note?: string
  /** Short marks, drawn in order: `draft`, `✗ 2`, `✓`, `you`, `conflicts`. */
  marks?: readonly { text: string; tone?: 'quiet' | 'good' | 'warning' | 'bad' }[]
  links?: readonly Link[]
  /** What a click runs, if anything: one of the extension's own tools. */
  opens?: { tool: string; input?: Record<string, unknown> }
  /** The Tade task this row is about, when it is about one. */
  task?: string
}

/**
 * A section an extension keeps in the sidebar: cheap, cached, and never on
 * the draw path. A section with nothing in it and nothing wrong is not drawn
 * at all — an empty heading is a row of nothing.
 */
export interface ExtensionList {
  /** Its name in the extension: `mine`. In the window it is `<extension>.<id>`. */
  id: string
  /** The section's heading: `REVIEWS`. */
  title: string
  /** How often it may be asked again, at the most: `60s`. The window never asks faster. */
  every: string
  /** Filters the section offers, the first being the default. */
  filters?: readonly { id: string; title: string }[]
  /** Rows, from the extension's own cache. Never throws: a problem is a row saying so. */
  rows(ctx: WindowContext, filter: string): Promise<readonly ListRow[]>
}

/** A few words an extension keeps in the window's status bar, clicked for its view. */
export interface StatusItem {
  text: string
  tone?: 'quiet' | 'warning' | 'bad'
}

/** What an extension asks with the window open: everything, and the window itself. */
export interface WindowContext extends ExtensionContext {
  tade: ExtensionWorkbench
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExtensionContext {
  /** Its own name. */
  extension: string
  /** What `extensions.<name>` says in the config, as written. */
  settings: Readonly<Record<string, unknown>>
  projects: readonly ProjectRef[]
  /**
   * A project by name, or the only one there is. Throws, in words a model can
   * act on, when there is no such project or it has to be said which.
   */
  project(name?: string | null): ProjectRef
  env: Readonly<Record<string, string | undefined>>
  fetch: typeof fetch
  /** Run a program. Never throws: a failure is its code and what it said. */
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult>
  /** Tade's home. */
  home: string
  now(): number
}

export interface ToolContext extends ExtensionContext {
  caller: Caller
  /** Say how it is going, while it works. */
  progress(text: string): void
  signal: AbortSignal
  /** What only an open window can do. Null when there is none — a question asked from the CLI. */
  tade: ExtensionWorkbench | null
}

export interface TadeExtension {
  /** Lowercase with dashes. Its settings live under this key; its tools start with it. */
  name: string
  title: string
  /** What it is for, in a sentence. */
  description: string
  /** Its own folder, for the harness pieces it ships. */
  root?: string
  settings?: readonly ExtensionSetting[]
  /**
   * Whether it can work here, and if not, what to do about it: a token to set,
   * a program to install. Null when it can. Never throws.
   */
  ready?(ctx: ExtensionContext): Promise<string | null> | string | null
  tools?: readonly ExtensionTool[]
  actions?: readonly ExtensionAction[]
  /** Work it can watch for, on a clock. Offered; nothing is watched until someone turns one on. */
  watches?: readonly ExtensionWatch[]
  /** Sections it keeps in the window's sidebar, asked for on their own clock. */
  lists?: readonly ExtensionList[]
  /** What belongs in the brief, when anything does. */
  brief?(ctx: ExtensionContext): Promise<readonly BriefItem[]>
  /** Told to the orchestrator: when to reach for this, and how. */
  orchestrator?(ctx: ExtensionContext): string
  /** Told to every agent working in a project: what it has, and how to use it there. */
  agents?(ctx: ExtensionContext, project: ProjectRef): string | null
  /** Text on screen that should open somewhere. */
  linkers?(ctx: ExtensionContext): readonly Linker[]
  /** How to set it up, and what can be changed about it, in the window. */
  setup?(ctx: ExtensionContext): ExtensionSetup
  /**
   * A few words for the status bar, asked every few seconds while the window
   * is open. It must be cheap: it runs whether or not anyone looks.
   */
  status?(ctx: WindowContext): Promise<StatusItem | null>
  /** What its status opens: a document, in markdown, asked for when shown and again while it is open. */
  view?(ctx: WindowContext): Promise<string>
  harness?: Readonly<Record<string, HarnessPieces>>
}
