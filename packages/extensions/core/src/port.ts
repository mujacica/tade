// The WilcoExtension port: something Wilco can do that it was not built
// knowing about — check a project's dependencies, read its errors in Sentry.
//
// An extension is harness-neutral. It declares tools as plain JSON Schema and
// runs them in the window's own process, and each harness is handed them in
// its own terms: pi as registered tools that call back to Wilco, a harness
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

/** A project Wilco has been told about. */
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

/** A button in the window, a line in ctrl+k, a `wilco extensions run`: one tool with its input. */
export interface ExtensionAction {
  id: string
  /** What it does, as a button says it: "Check dependencies". */
  title: string
  tool: string
  input?: Record<string, unknown>
  /** It works on a project, which is the one you are in. */
  project?: boolean
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

/** What an open window can do for an extension that nothing else can. */
export interface ExtensionWorkbench {
  /**
   * Put an agent to work on something, in a worktree of its own: the context
   * written where it will read it, the links kept with the task, and `prepare`
   * given the worktree before the agent starts, for changes it should begin
   * from.
   */
  startAgent(request: {
    project: string
    title: string
    prompt: string
    context?: string
    links?: readonly Link[]
    prepare?: (worktree: string) => Promise<void>
  }): Promise<{ task: string; worktree: string }>
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
  /** Wilco's home. */
  home: string
  now(): number
}

export interface ToolContext extends ExtensionContext {
  caller: Caller
  /** Say how it is going, while it works. */
  progress(text: string): void
  signal: AbortSignal
  /** What only an open window can do. Null when there is none — a question asked from the CLI. */
  wilco: ExtensionWorkbench | null
}

export interface WilcoExtension {
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
  /** What belongs in the brief, when anything does. */
  brief?(ctx: ExtensionContext): Promise<readonly BriefItem[]>
  /** Told to the orchestrator: when to reach for this, and how. */
  orchestrator?(ctx: ExtensionContext): string
  /** Told to every agent working in a project: what it has, and how to use it there. */
  agents?(ctx: ExtensionContext, project: ProjectRef): string | null
  /** Text on screen that should open somewhere. */
  linkers?(ctx: ExtensionContext): readonly Linker[]
  harness?: Readonly<Record<string, HarnessPieces>>
}
