import type { OnPlan, PlanStanding, Runtime } from '@tade/core'
import type { LanePointing, LaneScrolling } from '@tade/drivers-core'
import type { FileEntry } from './files.ts'
import type { LayoutPrefs } from './layout.ts'
import type { Linker } from './links.ts'
import type { ScheduleView } from './model.ts'
import type { PanelContext } from './panels/context.ts'
import type { AgentOffers, ThinkerOffers } from './panels/menu/state.ts'
import type { HeldLines } from './scroll.ts'
import type { Skin } from './skin.ts'
import type { SpendView } from './spend.ts'

// What the window is handed, as data.
//
// `view.ts` draws it and `panels/` draws the panel over it, but the shape of
// what they are given belongs to neither of them: `live.ts` fills most of it
// in without drawing anything, and a panel names a `Change` without knowing
// what a window looks like. Kept inside the drawing, it made a cycle out of
// two files that never call each other — `view` wants `drawPanel`, the panels
// wanted `Change` — and gave the polling a reason to import the renderer. So
// the contract lives here, on its own, and everything that has to name a
// piece of it reads this file.
//
// Types only. Nothing here runs and nothing here draws; a rule about any of
// it belongs in `model.ts`.

/**
 * What a harness lets a person ask of a running agent, and of a turn in
 * flight. They are declared beside the panels that read them, and named here
 * because the frame is what carries them.
 */
export type { AgentOffers, ThinkerOffers }

/**
 * What a lane's screen is like around its text: how many lines it holds,
 * where what you type lands — counted back from the last line captured, as
 * the driver reports it — and whose the scrolling is.
 */
export interface LaneView {
  lines: number
  cursor: { back: number; column: number }
  /**
   * Who the wheel over it belongs to, as the driver found the program in it
   * has left its screen. Absent where nothing has said yet, which reads as
   * the window's, because that is what every lane was until one said
   * otherwise.
   */
  scrolling?: LaneScrolling
  /**
   * How much of the pointer the program in it asked for, as the driver found
   * it. Absent where nothing has said yet, which reads as nobody's, because
   * that is what every lane was until one asked.
   */
  pointing?: LanePointing
}

/** A short word or figure with its own colour, as the window is handed one. */
export interface MarkView {
  text: string
  tone?: 'quiet' | 'good' | 'warning' | 'bad'
}

/**
 * A row an extension keeps in the sidebar, as the window draws it: two rows,
 * like every other item down the side.
 *
 * `marks` are what it *is* and go beside the name; `figures` are what it
 * *counts* and go under it. One row for both made them fight for the columns a
 * name needs, and the name is the one column that cannot be abbreviated
 * without lying.
 */
export interface ListRowView {
  /** `<extension>.<list>`, so a click knows which list it came from. */
  section: string
  id: string
  title: string
  /** What it is called on its own, in front of the title: `#412`. */
  label?: string
  note?: string
  marks?: readonly MarkView[]
  /** The figures under it: what its checks and verdicts came to, what blocks it. */
  figures?: readonly MarkView[]
  /** Since when it has been whatever it is, and the word for that: `3h open`. */
  age?: { since: number; says: string }
  links?: readonly { title: string; url: string }[]
  /** What clicking it runs: one of the extension's own tools. */
  opens?: { tool: string; input?: Record<string, unknown> }
  /** The task it is about, when it is about one. */
  task?: string
  /**
   * The project whose work it is: the side draws it in that project and
   * nowhere else. Absent is "nobody can say", and such a row is drawn in every
   * project rather than in none.
   */
  project?: string
}

/** A section an extension keeps in the sidebar. */
export interface ListSectionView {
  id: string
  title: string
  rows: readonly ListRowView[]
  /** Why there are no rows, when something is wrong. One quiet row says it. */
  problem: string | null
  /**
   * Whether its rows can be opened in a window of their own — the section's
   * own declaration, so a click knows before it asks. False is a section
   * clicked exactly as every section was before one could.
   */
  summarises?: boolean
}

/**
 * One row in full, once it has been asked for: the window a click opens.
 *
 * The window knows nothing about what is in it. A heading, marks under it,
 * named groups of marks, label-and-value facts, and links — a review, a Sentry
 * issue and a dependency all describe themselves in that.
 */
export interface RowSummaryView {
  title: string
  marks?: readonly MarkView[]
  groups?: readonly { label: string; marks: readonly MarkView[]; note?: string }[]
  facts?: readonly { label: string; value: string; tone?: MarkView['tone'] }[]
  links?: readonly { title: string; url: string }[]
}

/** A commit on the branch, as the ACTIONS tab draws it. */
export interface CommitView {
  sha: string
  subject: string
  at: number
  /** The task its `Tade-Task:` trailer names; null where it carries none. */
  task: string | null
  /** What it touched, as git counted it. Null where that could not be read. */
  files: number | null
  added: number | null
  removed: number | null
}

/** One check, as the ACTIONS tab draws it: what it is, what ran, and what it said. */
export interface CheckView {
  id: string
  /** What it checks, as the project says it. */
  title: string | null
  /** The command line, exactly as it runs. */
  run: string | null
  /** `passed`, `failed`, `running`, `queued`, `skipped`, `not run`. */
  state: string
  /** Merging waits on it. */
  required: boolean
  /**
   * Why it does not run here, in a few words: what the reading found, or that
   * somebody turned it off. Null is a check Tade runs on this machine, which
   * is the whole of how the page tells its two categories apart.
   */
  skip: string | null
  /**
   * What somebody said about running it here, over what the reading says —
   * `checks.run_here`. Null where nobody has said anything, which is what the
   * control on the row toggles between.
   */
  chosen: boolean | null
  /** Checks that must have passed first. */
  needs: readonly string[]
  /** One line, as the command said it last. Never invented. */
  summary: string | null
  /** How long it took — or, while it runs, when it started. */
  seconds: number | null
  startedAt: number | null
  /** When it finished. */
  at: number | null
  /** The commit it ran against. */
  commit: string | null
  /** It ran at an earlier commit, over the very bytes this one holds. */
  carried: boolean
  /** What its output said, read back from what it printed. */
  counts: readonly { label: string; count: number; tone: 'good' | 'bad' | 'quiet' }[]
  /** The files it named, and what about each. */
  places: readonly { path: string; at: string | null; note: string | null }[]
  /** Files it named beyond those. */
  more: number
  /** The last lines it printed, for reading a failure without leaving the page. */
  tail: readonly string[]
}

/**
 * What an agent has done, as the ACTIONS tab draws it: the commits that carry
 * its own trailer, what is not committed, the review it is out for and how
 * its project's checks stand at the commit in hand. Every field is a query
 * somebody else answered — nothing here is remembered, and drawing it reads
 * nothing.
 */
export interface ActionsView {
  task: string
  branch: string | null
  base: string | null
  ahead: number | null
  behind: number | null
  /** How many files are changed and not committed in the tree it works in. */
  dirty: number
  /**
   * It works in a checkout it shares with other agents, so which of those
   * files are its own cannot be told — which the page says, rather than
   * counting somebody else's work as this agent's.
   */
  shared: boolean
  /** The commit the checks are about. */
  commit: string | null
  /** Its own: the commits whose trailer names this task, newest first. */
  mine: readonly CommitView[]
  /** Everything else on the branch since it started, newest first. */
  others: readonly CommitView[]
  /**
   * The review this branch is out for, when a forge knows of one — the row the
   * extension keeps, as it keeps it, rather than a reading of the one drawn
   * down the side. Drawn in two rows here as it is there: what it is beside
   * its number, what its checks and verdicts came to underneath.
   */
  review: ListRowView | null
  checks: readonly CheckView[]
  /**
   * What the required checks add up to at this commit. `unknown` is a first
   * class answer: a check nobody ran is not a check that passed.
   */
  rollup: 'pass' | 'fail' | 'unknown'
  /** Where the checks were read from, or what to do when there are none. */
  source: string
  /**
   * What the reading could not place as a check at all: somebody's action, an
   * install, a job that deploys. Drawn beside the checks that do not run here,
   * because that is what they are — and said rather than dropped, since a list
   * that quietly holds less than CI does is how a tick here comes to be read
   * as a tick there.
   */
  unread: readonly string[]
  /** A run going on in this worktree now, whoever started it. */
  running: { since: number; by: string; done: number; total: number } | null
  /** What this cannot say: no forge, no network, what a local run does not prove. */
  notes: readonly string[]
}

/**
 * A note down the side: what was said, and what is known beside it.
 *
 * `summary` is a headline somebody wrote when the note was taken — never a
 * reading of `text`, which is kept word for word and is the only thing nothing
 * could recover. A note taken before anybody wrote one has none, and is drawn
 * in its own words instead.
 */
export interface NoteShown {
  text: string
  at: string
  summary?: string
  /** A task id, a project name, or null when it is about everything. */
  scope?: string | null
  /** Where it came from: `voice`, `window`, `cli`, `orchestrator`. */
  by?: string
}

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
  /**
   * How far back that lane can be read, and where typing lands in it: what the
   * scrollbar beside it and the block on it are drawn from. Absent where
   * nothing has been read yet, and the pane draws neither.
   */
  paneScreen?: LaneView | null
  /** The orchestrator's own screen, when it is running where you can see it. */
  orchestrator?: string
  /**
   * The terminal in front of the bottom panel: its screen as captured, and —
   * while finding in it — its scrollback as plain text, the line found, and
   * what was looked for.
   */
  terminal?: {
    screen: string
    find?: { lines: readonly string[]; line: number | null; query: string } | null
    /** How far back it can be read, and where typing lands in it. */
    view?: LaneView | null
  }
  /**
   * The lines the window is holding of the two lane screens, by which of them
   * it is. The screen drawn is a cut of these, so this is how far back a
   * selection in one reaches once it has been scrolled: as far as the window
   * has read, and no further — nothing here invents a line nobody has seen.
   */
  held?: ReadonlyMap<'pane' | 'terminal', HeldLines>
  /** The files of the focused agent's worktree, or of the project when there is none. */
  files?: readonly FileEntry[]
  /** What git says about those files, by path: `M`, `A`, `D`, `R`, `U`, `!`. */
  fileMarks?: Readonly<Record<string, string>>
  /**
   * Where the work is: the project's repository, the branch in front of you,
   * and — for an agent — the branch it started from and the worktree it is in.
   * Paths as you would type them.
   */
  where?: {
    repo: string
    branch: string | null
    base: string | null
    worktree: string | null
    /** Where that is on this machine, in full: the worktree, or the repository. */
    path: string
    /** The same, from your home as you would type it: `~/src/checkout`. */
    shownPath?: string
    /** Where the agent's work came from — an issue, a trace — each opened by a click. */
    links?: readonly { title: string; url: string }[]
  } | null
  /** What the focused agent has changed since it branched. */
  changes?: readonly Change[]
  /** What the focused agent has done, for the ACTIONS tab beside its screen. */
  actions?: ActionsView | null
  /** The sections extensions keep in the sidebar, as they last answered. */
  lists?: readonly ListSectionView[]
  /** The branch those changes are counted against. */
  base?: string | null
  /** Notes about this project and everything, oldest first: named by when they were said. */
  notes?: readonly NoteShown[]
  /** Today's spend, in total and by task. */
  spend?: Spend
  /**
   * How much of every sign-in's plan is used, as its harness last said — and
   * for the ones that cannot say, why not.
   *
   * All of them, whatever the strip has room to draw: which one it shows is the
   * window's to choose from these (`planShown`), and what is offered as
   * somewhere else to go is read from the ones it is not showing.
   *
   * Never money. A subscription is not charged per turn, so what is used up is
   * a share of a rolling window, and it is drawn as its own thing rather than
   * folded into a total that would then mean nothing.
   */
  plan?: readonly PlanStanding[]
  /**
   * What the agent you are looking at runs on, as configured, and how that
   * provider is paid for: `signed in`, `API key`, `env API key`.
   */
  route?: {
    harness: string
    model: string | null
    /** How hard new agents think, when a level was chosen. */
    thinking?: string | null
    provider: string | null
    credential?: string | null
  }
  /** What it says it actually runs on, and how full its context is. */
  vitals?: { model: string | null; thinking?: string | null; contextPercent: number | null } | null
  /**
   * What its harness lets a person ask of it. A control it does not offer is
   * not drawn; absent, everything is, as it always was.
   */
  offers?: AgentOffers | null
  /** The Spend panel's view, when it is open. */
  spendView?: SpendView | null
  /** What the open panel needs that the window does not: a menu, a diff, models. */
  panel?: Partial<
    Pick<
      PanelContext,
      | 'items'
      | 'changes'
      | 'ahead'
      | 'branch'
      | 'base'
      | 'diff'
      | 'choices'
      | 'settings'
      | 'accounts'
      | 'updates'
      | 'updatesBusy'
      | 'lanesSurvive'
      | 'configPath'
      | 'releases'
      | 'budgetWarnings'
      | 'levels'
      | 'openRows'
      | 'browsing'
      | 'homeDir'
      | 'entries'
      | 'talkKey'
      | 'talkMode'
      | 'running'
      | 'searching'
      | 'viewing'
      | 'branches'
      | 'checkout'
      | 'found'
      | 'terminalName'
      | 'extensions'
      | 'harnessExtensions'
      | 'servers'
      | 'extensionsRoot'
      | 'models'
      | 'modelsFrom'
      | 'modelTarget'
      | 'currentModel'
      | 'written'
      | 'setup'
      | 'extensionView'
      | 'summary'
      | 'away'
    >
  >
  /** The key you hold to talk, and whether there is anything to hear you. */
  voice?: { keys: readonly string[]; available: boolean }
  /** Tade's home, as you would type it, for showing where worktrees go. */
  home?: string
  /**
   * Who pays for the orchestrator's model: its provider, and what is wrong with
   * how it is paid for.
   *
   * `problem` is null in the ordinary case and nothing is drawn for it. The
   * strip used to say `signed in` there, which is the answer nobody needs: it
   * cost three columns to tell somebody that the thing they are talking to is
   * working. What belongs in a strip is what needs them — a provider with no
   * credential for it, which is a turn that will fail.
   */
  orchestratorAccount?: { provider: string | null; problem: string | null }
  /** Nothing is said or played. */
  muted?: boolean
  /**
   * The anti-sleep hold: whether the machine is being held awake now, and why
   * it is not where it cannot be (`NO_HOLD_HERE`, a spawn that failed).
   *
   * `held` is what came of the setting rather than the setting itself, so the
   * button can never say the machine is awake because somebody asked for it.
   * Undefined is a frame nothing looked for it in — the goldens, a panel drawn
   * on its own — and draws as not held, which is what it is by default.
   */
  awake?: { held: boolean; problem: string | null }
  /** A picture is on the clipboard, and has not been taken or turned down. */
  clipboardImage?: boolean
  /** Extensions that need setting up, or are broken: a badge beside the Extensions button. */
  extensionsNeedYou?: number
  /** The second lane of a split pane, as captured. */
  splitScreen?: string
  /** The second terminal of a split bottom panel. */
  splitTerminal?: Frame['terminal']
  /** The window's own keys as set, for the shortcuts sheet. */
  bindings?: Readonly<Record<string, string>>
  /** The orchestrator's input, as its editor draws it, rules included, while it is being typed in. */
  input?: { lines: string[] }
  /** What extensions keep in the status bar. */
  statuses?: readonly {
    extension: string
    text: string
    tone: 'quiet' | 'warning' | 'bad'
    viewable: boolean
  }[]
  /**
   * Tade's own tools, lent into each agent as an MCP server of its own, for the
   * light along the top: how many agents should have one, and how many do.
   *
   * This and not the brokered servers. The lamp is about whether the
   * `tade_*` tools an agent is holding actually work — a server that died takes
   * them with it, and because it is the harness's child rather than Tade's,
   * nothing is told when it goes. The brokered servers have the Extensions
   * page, which can say *why* about each of them.
   *
   * `expected` of nought draws nothing: no agent here takes its tools that way.
   */
  mcp?: { expected: number; alive: number; looked: boolean }
  /** The orchestrator's model, shown on its tab: undefined where the window has no orchestrator. */
  orchestratorModel?: string | null
  /** How hard the orchestrator thinks, as the config has it; null where nothing was chosen. */
  orchestratorThinking?: string | null
  /**
   * What its harness can be asked of a turn in flight, as `offer()` reads it.
   * Whether escape says it stops anything is read from here and never from
   * which harness it is.
   */
  orchestratorOffers?: ThinkerOffers | null
  /** Text extensions know how to open, made clickable wherever it is shown. */
  linkers?: readonly Linker[]
  now?: number
  /**
   * How a moment is said: `18:00`. The machine's own time unless given, which
   * the screens tests do, so a screen does not change with the time zone.
   */
  clock?: (at: number) => string
  /** Every schedule, as the SMART QUEUE shows it. */
  schedules?: readonly ScheduleView[]
  /** A moment with its date, for where a time alone would be ambiguous: `Mon 7 Sep 09:00`. */
  date?: (at: number) => string
  /** How to divide the window. Defaults when absent. */
  layout?: LayoutPrefs
  /** How to colour it. Plain unless told otherwise. */
  skin?: Skin
}

/**
 * How Tade's own tool servers are, in the one word a light has room for.
 *
 * `unknown` where nothing could look — never drawn as nought, which would read
 * as every one of them having gone. `gone` is the drop: an agent that should
 * have Tade's tools and has not got them.
 */
export type McpState = 'unknown' | 'alive' | 'gone'

export interface Spend {
  tokens: number
  usd: number
  hasCost: boolean
  /**
   * What the turns a plan paid for would have cost at list price, and not a
   * bill: a flat fee has no price per turn, so nobody is charged this and it is
   * in no figure above. The strip draws it marked as the estimate it is — in the
   * cost slot where there is no bill at all, beside the plan bar where there is
   * — because it is the figure `ccusage` gives, and without it a subscription's
   * whole day reads as `—`.
   */
  usdOnPlan?: number
  /**
   * Whether a rate covered all a plan's turns, some of them, or there were none
   * — absent, like `runtime`, in a frame assembled by something that is not
   * asking about money. Nothing to say and nothing on a plan draw the same.
   */
  onPlan?: OnPlan
  byTask: Readonly<Record<string, { tokens: number; usd: number }>>
  /** How long the agents have run today, all of them added together. */
  runtime?: Runtime
}
