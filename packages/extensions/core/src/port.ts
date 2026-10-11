import type { ExtensionWatch } from './watch.ts'

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
  /**
   * `secret` is a credential — an API key, a token. It is a setting like any
   * other and is written into `config.yaml`, which is `0600` and one person's;
   * what marks it is that it is drawn in its own field, that an environment
   * variable wins over it, and that you read it with `ctx.secret` rather than
   * out of `ctx.settings`, so the two can never disagree about which is live.
   */
  kind: 'string' | 'boolean' | 'number' | 'list' | 'map' | 'secret'
  /**
   * For a `secret`: the environment variable it has always been read from,
   * or several, in order. Whatever is set there wins over what was pasted, so
   * a machine that works today goes on working exactly as it does.
   */
  env?: string | readonly string[]
  /**
   * For a `secret`: the setting somebody names a different environment
   * variable in (`key_env`), for an extension that offers one.
   */
  envFrom?: string
}

/** A credential, and where it came from — the place, never a second copy of the value. */
export interface SecretFound {
  value: string
  /** How to say where it came from: `$TYPESAFE_API_KEY`, `config.yaml`. */
  from: string
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
   * yours reports to; `flag` is on or off; `secret` is a credential, shown as
   * itself so it can be checked — declare it as a `secret` setting too.
   */
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret'
  /** Values to offer, looked up when asked: the organizations a token can see. */
  choices?(ctx: ExtensionContext): Promise<readonly string[]>
}

/**
 * How to set an extension up, in the window: what it needs in words, the
 * settings to fill in — a key among them, as a `secret` field — and where to
 * go for what has to be got somewhere else.
 */
export interface ExtensionSetup {
  /** Steps, in markdown, in the order to take them. */
  guide: readonly string[]
  fields?: readonly SetupField[]
  links?: readonly Link[]
}

/**
 * A tool call an agent is held at, offered for a second reading.
 *
 * Tade has already made up its own mind about it — `decided` is what its rules
 * say, and they are pure, table-tested and the thing that actually answers.
 * This is asked beside them, about the commands nobody wrote a rule for.
 */
export interface CautionRequest {
  project: string
  /** The task whose agent asked, where there is one. */
  task: string | null
  /** Where that agent works. Everything outside it is somebody else's. */
  worktree: string
  /** The tool it called, in its harness's words. */
  tool: string
  /** The command, where the call is one; null when it is not. */
  command: string | null
  input: Readonly<Record<string, unknown>>
  /** What Tade made of it on its own, before anybody else read it. */
  decided: { tier: 'auto' | 'soft' | 'hard'; rule: string; reason: string }
  /** Dropped when the answer is no longer wanted: an agent is waiting on this. */
  signal: AbortSignal
}

/**
 * What a second reading adds, or null for nothing to add.
 *
 * It may only ever be stricter than what Tade decided: there is no `auto` to
 * answer with, nothing here allows anything, and an answer that is not
 * stricter changes nothing at all. `reason` is one clause a person reads —
 * whatever produced it, what reaches them is a sentence somebody wrote.
 */
export interface CautionAnswer {
  tier: 'soft' | 'hard'
  reason: string
  /** What answered, and which version of it: kept with the record. */
  version?: string
}

/**
 * A sentence somebody typed into search, and the things it could have meant.
 *
 * Every choice is something the window already has in its list: this asks
 * which of them was meant, never what else could be done. Nothing that comes
 * back is run — it is shown, and the person still chooses.
 */
export interface MeantRequest {
  /** What they typed, exactly as they typed it. */
  said: string
  /**
   * What it could be: the words the person would see, and what is happening
   * about each — what an agent is doing, what it was asked for, what queued
   * work waits on.
   *
   * `about` is the half that makes a sentence answerable: "the agent on test
   * coverage" is in nobody's name. It is also the half that leaves the
   * machine, so the window bounds how much of it there is and a person decides
   * whether any of it is offered at all (`surfaces.search.context`) — with it
   * off, every choice arrives with none, which is a question worth asking and
   * a narrower one.
   */
  choices: readonly { id: string; label: string; detail?: string; about?: string }[]
  /** Dropped when the answer is no longer wanted: somebody is watching the box. */
  signal: AbortSignal
}

/** What an open window can do for an extension that nothing else can. */
/**
 * What one agent has been doing lately, as the window watched it happen: the
 * tools it ran and how its turns ended. A reading, not a record — it goes back
 * as far as the window has been open and no further, and nothing here is in
 * the journal.
 */
export interface AgentDoing {
  task: string
  project: string
  /** When the run started. */
  startedAt: number
  /** Whether it is mid-turn, as it last said. */
  turn: 'running' | 'idle' | 'unknown'
  /** The last tools it ran, oldest first. */
  did: readonly { at: number; tool: string; about: string; ok: boolean | null }[]
  /** How its last turns ended, oldest first. */
  ends: readonly { at: number; status: 'ok' | 'error' | 'aborted' }[]
}

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
    /** A tree nobody else is in, whatever the project says. See `WatchAgent.alone`. */
    alone?: boolean
  }): Promise<{ task: string; worktree: string }>
  /** Tade's own process: the window. */
  readonly pid: number
  /** What Tade is running: every lane, with the task it belongs to and its process. */
  lanes(): readonly { id: string; task: string; kind: string; pid: number | null; alive: boolean }[]
  /**
   * What each agent has been doing lately. For reading whether an agent is
   * getting anywhere; there is nothing here to act with, and acting on what it
   * says is somebody else's — a person's, or the orchestrator's.
   */
  agents(): readonly AgentDoing[]
}

/** A short word or figure with its own colour: the only painted thing a row has. */
export interface RowMark {
  text: string
  tone?: 'quiet' | 'good' | 'warning' | 'bad'
}

/**
 * A row an extension keeps in the window: what it is, how it is going, and
 * where clicking it goes. The window draws it and knows nothing else about
 * it — which is what keeps the sidebar from having to learn what a forge is.
 *
 * It is drawn as **two rows**, which is what every other item down the side
 * is: the name and what it *is* on the first, the figures it *counts* on the
 * second. One row made the two fight for the same columns, and the name lost —
 * `#418  …     draft ✗ checks` is what a review looked like in a side twenty-
 * eight columns wide. Which half a thing goes in is the whole of the contract:
 * `marks` say what it is and whether it wants somebody, `figures` say what it
 * adds up to.
 */
export interface ListRow {
  /** Stable, so the cursor stays on the same row across polls. */
  id: string
  title: string
  /**
   * What it is called on its own, in front of the title: `#412`. Kept apart
   * from the title so nothing has to split a drawn string back up to find it —
   * which is what the ACTIONS page used to do, on two spaces.
   */
  label?: string
  /** A few words to the right: a repository, a branch, a time. */
  note?: string
  /** Short marks, drawn in order on the first row: `draft`, `merged`, `you`. */
  marks?: readonly RowMark[]
  /**
   * The figures under it, drawn in order on the second row: what the checks
   * came to, what the verdicts came to, what is blocking it. Never a sentence
   * — this is two rows of marks and figures, not a paragraph.
   */
  figures?: readonly RowMark[]
  /**
   * How long it has been whatever it is, as the moment it began and the word
   * for what that is: `{ since, says: 'open' }` is drawn `3h open`.
   *
   * The moment, never the figure: the window draws four times a second and a
   * list is polled once a minute, so an elapsed time worked out at the poll is
   * a minute stale every time it is read.
   */
  age?: { since: number; says: string }
  links?: readonly Link[]
  /** What a click runs, if anything: one of the extension's own tools. */
  opens?: { tool: string; input?: Record<string, unknown> }
  /** The Tade task this row is about, when it is about one. */
  task?: string
  /**
   * The project whose work it is, so the window draws it down that project's
   * side and nowhere else. The extension's answer, because only it can say:
   * it polls everything at once, and which project a thing belongs to is a
   * fact about the thing, not about which list it came back in.
   *
   * Absent is **"nobody here can say"**, and such a row is drawn in every
   * project rather than in none — a row hidden everywhere is a row nobody can
   * find, which is worse than one in the wrong place.
   */
  project?: string
}

/**
 * One row in full, for the window to put in front of somebody: what it is,
 * what it adds up to, and where it goes.
 *
 * It is asked for when a row is **clicked** and never on a poll, because in
 * full is what costs — a review's checks and its verdicts are their own
 * requests. So the list stays one cheap poll and the detail is an act.
 *
 * The window knows nothing about what is in one: a heading, marks, groups of
 * marks, label-and-value facts, and links. A forge, an issue tracker and a
 * dependency all describe themselves in that and the window draws all three
 * the same way.
 */
export interface RowSummary {
  /** What it is called, in full: the heading of the window it opens in. */
  title: string
  /** Under the heading: what it is, and whether it wants somebody. */
  marks?: readonly RowMark[]
  /**
   * Named sets of marks, each its own small heading: the checks that ran, the
   * verdicts given. A group with nothing in it says so rather than going —
   * "nothing has run" is an answer, and an absent heading is not.
   */
  groups?: readonly { label: string; marks: readonly RowMark[]; note?: string }[]
  /** Label and value, in order: the branches, the task, who wrote it. */
  facts?: readonly { label: string; value: string; tone?: RowMark['tone'] }[]
  links?: readonly Link[]
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
  /**
   * One of those rows in full, by its `id`, for the window that opens when it
   * is clicked. Asked on the click and never on the poll, so it may cost a
   * request; `null` is "there is nothing more to say about this one", and the
   * click then does what it always did — runs the row's `opens`.
   *
   * A section that offers none is clicked exactly as it was before this
   * existed.
   */
  summary?(ctx: WindowContext, id: string): Promise<RowSummary | null>
}

/** A tab an extension's view offers, the first being the default. */
export interface ViewTab {
  /** Its own name for it: `overview`. Handed back as `ViewAt.tab`. */
  id: string
  /** What the tab is called on the page. */
  title: string
}

/**
 * Where a view is being read: which tab, and how far back.
 *
 * The window decides what a day is and hands the moment over, because there is
 * one idea of a day in Tade (`sinceOf`) and an extension inventing a second one
 * is how a page comes to disagree with the Spend panel about what happened this
 * morning. An extension that declares no tabs and no window is given the first
 * tab of none and a `since` of zero, which is every page written before this
 * existed, unchanged.
 */
export interface ViewAt {
  /** The tab chosen, out of `viewTabs`, or empty where it offers none. */
  tab: string
  /** Only what happened at or after this. Zero means everything there has ever been. */
  since: number
  /** Which range that is, in the window's own words: `today`, `window`, `week`, `month`, `all`. */
  window: string
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
  /**
   * A credential this extension declared as a `secret` setting: from the
   * environment when it is set there — the variables the setting declared,
   * and the one its `envFrom` setting names — otherwise the setting itself,
   * out of `config.yaml`. Read it here and never out of `ctx.settings`: this
   * is the one place that knows the environment wins.
   */
  secret(key: string): SecretFound | null
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
  /**
   * How it is actually used, for a person: a handful of lines, each one way it
   * is reached for, in the order somebody would meet them. Written for the
   * Extensions page rather than for a model — `orchestrator()` and `agents()`
   * are what the models are told — because a page that says only what an
   * extension *is* leaves everybody believing it does whatever its one watch
   * does. A workflow is not a feature list: say what somebody is doing when
   * this happens, and what it gets them.
   *
   * **One short line each**, under about 80 characters, because these are read
   * as a list and a list of paragraphs is a list nobody finishes. The caveat,
   * the second clause and the aside belong in the tool's own description,
   * where whoever is choosing it reads them.
   */
  workflow?: readonly string[]
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
  /**
   * A second reading of a tool call an agent is held at, for what the approval
   * rules do not name. It runs with an agent waiting, so it is given a
   * deadline and missing it is today's answer arriving on time — never an
   * error, and never a hold of its own.
   */
  caution?(ctx: ExtensionContext, request: CautionRequest): Promise<CautionAnswer | null>
  /**
   * Which of the things in front of somebody they meant, when the letters they
   * typed matched none of them. Answered with ids from `choices` and nothing
   * else — an id that was not offered is dropped — best first, and an empty
   * list where none of them was meant. Somebody is watching the box, so it is
   * given a deadline and a late answer is never shown.
   */
  meant?(ctx: ExtensionContext, request: MeantRequest): Promise<readonly string[]>
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
  /**
   * Tabs its view offers, the first being the default. None is one page, which
   * is what every view was before this.
   */
  viewTabs?: readonly ViewTab[]
  /**
   * Whether its view is about a window of time somebody can change — today,
   * this window, seven days — drawn by the window as the Spend panel's is. A
   * view that is about *now* (what Tade is using this minute) declares nothing
   * and is handed a `since` of zero.
   */
  viewWindowed?: boolean
  /** What its status opens: a document, in markdown, asked for when shown and again while it is open. */
  view?(ctx: WindowContext, at: ViewAt): Promise<string>
  harness?: Readonly<Record<string, HarnessPieces>>
}
