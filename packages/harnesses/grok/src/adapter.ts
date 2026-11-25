import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type RequiredProgram,
  runProgram,
  type TaskId,
  type ThinkingLevel,
  type ToolEffect,
  type Unsubscribe,
} from '@tade/core'
import {
  type AccountStatus,
  endHeadless,
  forgetRunFiles,
  type HarnessAccount,
  type HarnessModel,
  type HarnessProbe,
  type HarnessSession,
  type HarnessSpend,
  type HistoryAsk,
  type HistoryPage,
  type LaunchSpec,
  type ModelFound,
  noHarnessSpend,
  type PermissionDecision,
  PermissionNotPendingError,
  type PlanLimits,
  promptWithImages,
  type RunId,
  reaped,
  runFolderName,
  type SignIn,
  type SignInHere,
  signInHere,
  type ToolAnswer,
  WORKER_ENV,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerHandle,
  type WorkerImage,
  type WorkerModel,
  WorkerNotFoundError,
  type WorkerSignal,
  type WorkerSignalListener,
  type WorkerSpec,
} from '@tade/harnesses-core'
import { UNHEARD } from './ask.ts'
import { EFFORTS, grokCapabilities } from './capabilities.ts'
import { type ChannelRequest, GrokChannel } from './channel.ts'
import { exitReason, headlessArgs, headlessEnv, headlessEvent } from './headless.ts'
import { COMPAT_OFF, type HomeParts, ownGrokHome, readyHome, trustIn } from './home.ts'
import { endsTurn, type Missed, takeMissed } from './missed.ts'
import {
  addTurn,
  answerOn,
  historyOn,
  recordFor,
  sessionIdFor,
  spentIn,
  spentOn,
  toolOf,
  turnIn,
} from './record.ts'
import { carryAcross, carryInto, sessionsIn } from './sessions.ts'

// Drives Grok Build — xAI's official `grok`, unmodified — as a Tade worker, in
// a lane you can watch, signed in however its owner signed it in.
//
// Nothing of ours runs inside it the way the supervision extension runs inside
// pi. What it tells us arrives through its hooks, its status line and an MCP
// server, and Grok reads all three only out of its home folder — it has no
// flag that hands any of them over for one run — so every account Tade runs it
// as is a `GROK_HOME` of Tade's (`home.ts`) holding them, inert without the
// supervision environment. What we tell it is typed into its terminal, as a
// person would; Grok queues what is typed during a turn and sends it when the
// turn ends, so nothing reaches a turn already running.
//
// Grok copied much of Claude Code's dialect on purpose — its hooks carry the
// same fields, `--session-id` takes a UUID we choose — and this adapter is the
// Claude Code one's shape where Grok behaves the same and its own where it
// does not: what it calls its tools, how a turn is stopped (Ctrl+C, never
// Escape), the three hooks a turn can end with, and a record that is ACP
// session updates rather than a transcript.

export const HOOK_PATH = fileURLToPath(new URL('./hook.ts', import.meta.url))
export const STATUSLINE_PATH = fileURLToPath(new URL('./statusline.ts', import.meta.url))
export const MCP_PATH = fileURLToPath(new URL('./mcp.ts', import.meta.url))

/** The harness's name, as tasks, routes and the journal say it. */
export const GROK = 'grok'

/**
 * What a Claude Code tells the programs it runs about itself. Grok reads
 * Claude Code's settings for compatibility, and started from inside a Claude
 * Code session it would be handed that session's messaging socket and id: an
 * agent of Tade's is nobody's child.
 */
const INHERITED_SESSION = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
]

/**
 * How an agent is started or brought back: one line either way.
 *
 * Grok starts a new session under an id it is given (`-s`) and refuses one it
 * already has, and `-r` comes back to one it has, so the line looks for the
 * session's folder first and says whichever is true. That keeps the line Tade
 * writes down the one that reattaches, wherever it is run from. The account's
 * folder is the one it runs in, whatever the environment said; a key Grok
 * would otherwise take over its own sign-in is dropped, and an API-key
 * account's key is read from where Tade keeps it by the command that prints it
 * — never written on the line. The instructions are read from their file here
 * for the same reason: the line stays the same however long they are.
 */
const LAUNCHER = [
  'id="$1"; home="$2"; bin="$3"; rules="$4"; key="$5"; shift 5',
  `unset XAI_API_KEY GROK_CODE_XAI_API_KEY GROK_CONFIG GROK_CONFIG_PATH ${INHERITED_SESSION.join(' ')}`,
  'GROK_HOME="$home"; export GROK_HOME',
  'if [ -n "$key" ]; then XAI_API_KEY="$(/bin/sh -c "$key")" || exit 1; export XAI_API_KEY; fi',
  'if [ -n "$rules" ] && [ -f "$rules" ]; then set -- --rules "$(cat "$rules")" "$@"; fi',
  'if [ -n "$(find "$home/sessions" -mindepth 2 -maxdepth 2 -type d -name "$id" -print 2>/dev/null | head -n 1)" ]; then',
  '  exec "$bin" -r "$id" "$@"',
  'fi',
  'exec "$bin" -s "$id" "$@"',
].join('\n')

/** How long after a turn ends what it used is counted: Grok writes it down just after its Stop hook. */
const COUNT_AFTER_MS = 1_500

/** How long Ctrl+C is given to stop a turn before the line it put back is cleared. */
const CLEAR_AFTER_MS = 400

/**
 * How many tokens each of xAI's models holds, for a headless turn, which says
 * how full it is in tokens and never out of how many. From xAI's model list
 * (docs.x.ai/docs/models, 2026-11-25); a model not here is said in tokens alone.
 */
const WINDOWS: Readonly<Record<string, number>> = {
  'grok-4.7': 500_000,
  'grok-4.6': 500_000,
  'grok-4.5': 500_000,
}

export interface GrokAdapterOptions {
  /** Directory for per-run files: the instructions, pictures. */
  runDir: string
  /** Where supervision sockets go; a short path, because a long one fails to bind. */
  socketDir?: string
  approvals?: 'bypass' | 'policy'
  /** The `grok` to run. Found on the PATH by default. */
  bin?: string
  /**
   * The folder this account's Grok runs in (`GROK_HOME`). An added account's
   * own folder when there is one; otherwise Tade's folder for Grok's own
   * sign-in, beside its runs.
   */
  grokHome?: string
  env?: NodeJS.ProcessEnv
  /** Extra arguments appended to every launch, for tests that need it told something. */
  args?: string[]
  /** Type into an agent's terminal: how anything is said to it, since it listens nowhere else. */
  type?: (run: RunId, text: string) => Promise<void>
  onWarning?: (message: string) => void
  /** The account it runs as, when not the harness's own sign-in. */
  account?: HarnessAccount
  /** For tests: whose home your own `~/.grok` is in, which an account shares from. */
  home?: string
}

interface Waiter<T> {
  resolve: (value: T) => void
}

interface Run {
  handle: WorkerHandle
  spec: WorkerSpec
  /** The socket its hooks report over, for an agent in a lane. */
  channel: GrokChannel | null
  /** Whether this run is headless: a process per turn, which Tade draws itself. */
  headless: boolean
  /** The process of the turn running now, for a headless run. */
  child: ChildProcess | null
  /** The last it wrote to standard error, which is where it says why it would not start. */
  stderr: string
  /** What its own stream said went wrong (`{"type":"error"}`), whole: the reason, where there is one. */
  error: string
  /** Tade asked for the turn to stop, so the end of it is not a failure. */
  aborting: boolean
  cwd: string
  /** Whether a turn is running, as its hooks said. `starting` until the session has begun. */
  turn: 'starting' | 'running' | 'idle'
  /** The turn running now, as Grok names it: a late word about another is not about this one. */
  promptId: string | null
  /** Said while it could not be typed yet, or while a headless turn ran, to be said next. */
  queued: string[]
  /** A name chosen while a turn ran, given once it ends. */
  naming: string | null
  /** Everything typed into its terminal, in order: a paste and its Enter are never split. */
  typing: Promise<void>
  /** Counting what it used, one at a time, so a turn is never counted twice. */
  counting: Promise<void>
  countTimer: NodeJS.Timeout | null
  held: Map<string, Waiter<PermissionDecision>>
  calls: Map<string, Waiter<{ ok: boolean; text: string }>>
  /** A name was chosen by a person, so none is guessed. */
  named: boolean
  titled: boolean
  /** What its record had spent when we last said, so each turn sends only the difference. */
  spent: HarnessSpend
  model: string | null
  context: number | null
  /** A headless turn's reply so far, said whole at its end. */
  reply: string
  /** The prompt of a headless turn's last model call, in tokens: how full it is. */
  prompt: number
}

export class GrokAdapter implements WorkerAdapter {
  readonly id = GROK
  /** xAI, through Grok's own sign-in or an xAI key: it reaches no router. */
  readonly provider = 'xai'

  get capabilities(): WorkerCapabilities {
    return grokCapabilities(this.opts.account)
  }

  readonly programs: readonly RequiredProgram[] = [
    {
      command: 'grok',
      title: 'Grok Build',
      why: 'being the agent, for every task set to run in it',
      versionArgs: ['--version'],
      // No package manager carries it: xAI's own installer is the one way in,
      // and a package called `grok` on npm is somebody else's program.
      install: { instead: 'x.ai/cli: curl -fsSL https://x.ai/cli/install.sh | bash' },
    },
  ]

  private readonly runs = new Map<string, Run>()
  /** Runs being taken in, until whoever asked has them: what reaches one meanwhile waits. */
  private readonly arriving = new Map<string, Promise<void>>()
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly opts: Required<Omit<GrokAdapterOptions, 'type' | 'home' | 'account'>> & {
    type: GrokAdapterOptions['type']
    home: string
    account: HarnessAccount | undefined
  }
  /** The status line this account had of its own, run in front of; read when its folder is readied. */
  private theirStatusLine: string | null = null

  constructor(opts: GrokAdapterOptions) {
    const home = opts.home ?? homedir()
    this.opts = {
      runDir: opts.runDir,
      socketDir: opts.socketDir ?? opts.runDir,
      approvals: opts.approvals ?? 'bypass',
      bin: opts.bin ?? 'grok',
      args: opts.args ?? [],
      grokHome: opts.account?.dir ?? opts.grokHome ?? join(dirname(opts.runDir), 'grok'),
      env: opts.env ?? process.env,
      type: opts.type,
      onWarning: opts.onWarning ?? (() => {}),
      home,
      account: opts.account,
    }
  }

  /** The folder this account's Grok runs in. */
  get grokHome(): string {
    return this.opts.grokHome
  }

  async probe(): Promise<HarnessProbe> {
    const said = await runProgram(this.opts.bin, ['--version'], {
      timeoutMs: 10_000,
      env: this.accountEnv(),
    })
    if (said.code !== 0) {
      return {
        ok: false,
        version: null,
        problems: [
          said.missing
            ? `Grok Build is not installed (no ${this.opts.bin} on the PATH)`
            : `Grok Build would not say its version: ${said.stderr.trim() || `it exited ${said.code}`}`,
        ],
      }
    }
    const version = /\d+\.\d+\.\d+/.exec(said.stdout)?.[0] ?? null
    const status = await this.account()
    const problems = status.signedIn
      ? []
      : [
          `Grok Build is not signed in in Tade's folder for it: sign in from Settings, or run GROK_HOME=${this.opts.grokHome} grok login`,
        ]
    return { ok: problems.length === 0, version, problems }
  }

  /**
   * Grok's tools by what they do. Its own names, and the client names it
   * answers to as well (`Shell`, `StrReplace`); anything unknown is judged as
   * unknown.
   */
  effectOf(tool: string): ToolEffect {
    switch (tool) {
      case 'read_file':
      case 'hashline_read':
      case 'list_dir':
      case 'grep':
      case 'search_tool':
      case 'web_search':
      case 'web_fetch':
        return 'read'
      case 'search_replace':
      case 'hashline_edit':
      case 'write':
      case 'StrReplace':
      case 'EditNotebook':
        return 'write'
      case 'run_terminal_command':
      case 'monitor':
      case 'Shell':
        return 'exec'
      default:
        return 'other'
    }
  }

  conversationKey(task: string): string {
    return sessionIdFor(task)
  }

  async hasConversation(task: string, _cwd: string): Promise<boolean> {
    const record = await recordFor(task, this.opts.grokHome)
    return record !== null && existsSync(record)
  }

  async spent(task: string, _cwd: string): Promise<HarnessSpend> {
    const spent = await spentOn(task, this.opts.grokHome)
    return { ...spent, usd: this.priceable(spent.usd) }
  }

  history(task: string, _cwd: string, ask: HistoryAsk): Promise<HistoryPage> {
    return historyOn(task, this.opts.grokHome, ask)
  }

  callAnswer(task: string, _cwd: string, call: string): Promise<ToolAnswer | null> {
    return answerOn(task, this.opts.grokHome, call)
  }

  sessions(cwd: string, tasks: readonly TaskId[]): Promise<HarnessSession[]> {
    return sessionsIn(cwd, this.opts.grokHome, tasks)
  }

  carrySession(session: string, task: string, cwd: string): Promise<boolean> {
    return carryInto(session, task, cwd, this.opts.grokHome)
  }

  /**
   * What it can be started on, as `grok models` lists them for this account —
   * which is what its sign-in can reach. Nothing when it cannot say, and the
   * reason is `why.models`.
   */
  async models(): Promise<HarnessModel[]> {
    const ran = await runProgram(this.opts.bin, ['models'], {
      timeoutMs: 15_000,
      env: this.accountEnv(),
    })
    if (ran.code !== 0) return []
    const models: HarnessModel[] = []
    for (const line of ran.stdout.split('\n')) {
      const id = /^\s*[*-]\s+(\S+)/.exec(line)?.[1]
      if (!id || models.some((one) => one.id === `xai/${id}`)) continue
      const window = WINDOWS[id]
      models.push({
        id: `xai/${id}`,
        provider: 'xai',
        name: line.includes('(default)') ? `${id}, its default` : id,
        ...(window ? { contextWindow: window } : {}),
      })
    }
    return models
  }

  /**
   * "grok 4.6", "the grok-4.5 model", "xai/grok-4.6": a full name is taken as
   * it was said, for Grok to accept or refuse — it says which it runs, and a
   * list kept here would be out of date the first time a model came out.
   */
  async resolveModel(said: string): Promise<ModelFound> {
    const words = said
      .toLowerCase()
      .replace(/^(the\s+)?/, '')
      .replace(/\s+model$/, '')
      .trim()
      .replace(/^grok\s+(?=\d)/, 'grok-')
    if (!words) return { ok: false, reason: 'which model?' }
    const full = /^(xai\/)?([a-z][a-z0-9.\-[\]=]*)$/.exec(words)
    if (full?.[2]) return { ok: true, provider: 'xai', id: full[2] }
    return {
      ok: false,
      reason: `Grok runs a model by its name, as grok models lists them: which is "${said}"?`,
    }
  }

  /** Nothing, ever: Grok shows how much of a plan is used only inside its own terminal. */
  limits(): PlanLimits | null {
    return null
  }

  async askLimits(): Promise<PlanLimits | null> {
    return null
  }

  /**
   * Whether this account is signed in, as Grok says it when asked what models
   * it has: it prints "You are not authenticated" with no session to use. It
   * says nothing of who, so nothing is said of who. An API-key account is
   * signed in when it has its key.
   */
  async account(): Promise<AccountStatus> {
    const none = { signedIn: false, who: null, plan: null, method: null }
    if (this.opts.account?.kind === 'api-key') {
      return {
        ...none,
        signedIn: Boolean(this.opts.account.key),
        method: 'api-key',
        problem: this.opts.account.key ? null : 'this account has no API key yet',
      }
    }
    const ran = await runProgram(this.opts.bin, ['models'], {
      timeoutMs: 15_000,
      env: this.accountEnv(),
    })
    if (ran.missing) return { ...none, problem: 'Grok Build is not installed' }
    const said = `${ran.stdout}\n${ran.stderr}`
    if (/not authenticated|not signed in|grok login/i.test(said)) {
      return { ...none, problem: 'not signed in yet' }
    }
    if (ran.code !== 0) {
      return {
        ...none,
        problem: `Grok Build would not say whether it is signed in: ${ran.stderr.trim() || `it exited ${ran.code}`}`,
      }
    }
    return { signedIn: true, who: null, plan: null, method: 'grok.com', problem: null, until: null }
  }

  /**
   * Its own sign-in, in a terminal you can see, in this account's folder: it
   * opens your browser at auth.x.ai, and what it is given goes where Grok
   * keeps it — Tade never sees it. With no browser here it uses the device
   * code instead. An API-key account has nothing to sign in to.
   */
  signIn(here: SignInHere = signInHere(this.opts.env)): SignIn | null {
    if (this.opts.account?.kind === 'api-key') return null
    this.ready()
    return {
      launch: {
        command: this.opts.bin,
        args: here.browser ? ['login'] : ['login', '--device-auth'],
        env: { GROK_HOME: this.opts.grokHome },
      },
      how: here.browser
        ? 'Grok opens your browser to sign in to your xAI account at auth.x.ai. Sign in there, then come back here.'
        : 'Grok prints a code and a link: open the link on any device, sign in to your xAI account and enter the code.',
    }
  }

  /** Its sessions: never the whole folder, whose sign-in a backup has no business holding. */
  records(): readonly string[] {
    return [join(this.opts.grokHome, 'sessions')]
  }

  async signOut(): Promise<void> {
    const ran = await runProgram(this.opts.bin, ['logout'], {
      timeoutMs: 30_000,
      env: this.accountEnv(),
    })
    if (ran.code !== 0) throw new Error(ran.stderr.trim() || `grok logout exited ${ran.code}`)
  }

  /**
   * A folder of its own, private to you, with Tade's hooks and tool server in
   * it — and your own skills, agents and rules linked in when shared. Its
   * sign-in is its own: that is the point of it.
   */
  async prepareAccount(share: boolean): Promise<void> {
    this.ready(share)
  }

  /** Copy a task's session into another account's folder, where its Grok will find it. */
  async carryConversation(task: string, _cwd: string, to: WorkerAdapter): Promise<boolean> {
    if (!(to instanceof GrokAdapter) || to.opts.grokHome === this.opts.grokHome) return false
    return carryAcross(task, this.opts.grokHome, to.opts.grokHome)
  }

  /** Each run's folder of what launches it: never its session, which is the task's. */
  forgetRuns(runs: readonly RunId[]): Promise<RunId[]> {
    return forgetRunFiles(join(this.opts.runDir, 'grok'), runs, (run) => [runFolderName(run)])
  }

  launchSpec(spec: WorkerSpec): LaunchSpec {
    this.ready()
    const files = this.filesFor(spec)
    const key = this.opts.account?.kind === 'api-key' ? (this.opts.account.key ?? '') : ''
    return {
      command: '/bin/sh',
      args: [
        '-c',
        LAUNCHER,
        'tade-grok',
        sessionIdFor(spec.task),
        this.opts.grokHome,
        this.opts.bin,
        files.instructions ?? '',
        key,
        // Tade's own gate decides what is held; Grok asking as well would ask
        // twice, in a lane nobody may be looking at.
        '--permission-mode',
        'bypassPermissions',
        ...(spec.model ? ['-m', modelName(spec.model)] : []),
        ...(spec.thinking ? ['--reasoning-effort', effortOf(spec.thinking)] : []),
        ...this.opts.args,
      ],
      env: this.runEnv(spec),
      // Its first message, said at the first launch only.
      ...(spec.prompt ? { opening: [promptWithImages(spec.prompt, spec.images, files.dir)] } : {}),
    }
  }

  async supervise(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    let arrived = (): void => {}
    const arriving = new Promise<void>((resolve) => {
      arrived = resolve
    })
    this.arriving.set(spec.run, arriving)
    let taken = (): void => {}
    try {
      this.ready()
      // A folder Grok has never been trusted in stops it with a question
      // before anything starts, and holds its hooks back until it is answered.
      await trustIn(this.opts.grokHome, spec.cwd).catch((err) =>
        this.opts.onWarning(
          `could not mark ${spec.cwd} as trusted for Grok, so it will ask in its lane: ${(err as Error).message}`,
        ),
      )
      const socket = runSocket(this.opts.socketDir, spec.run)
      const channel = await GrokChannel.listen({
        path: socket,
        onRequest: (request) => this.onRequest(spec.run, request),
        onWarning: this.opts.onWarning,
      })
      const missed = await takeMissed(socket).catch((err: unknown) => {
        this.opts.onWarning(
          `could not read the turn a Grok agent ended while Tade was away, so it is not said: ${(err as Error).message}`,
        )
        return null
      })
      const record = await recordFor(spec.task, this.opts.grokHome)
      const text = record
        ? await readFile(record, 'utf8').catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              this.opts.onWarning(
                `could not read ${record}, so a Grok agent's spend is counted from nothing and, taken back, it is taken to be between turns: ${err.message}`,
              )
            }
            return ''
          })
        : ''
      const run = this.runFor(spec, channel, false)
      // A conversation it comes back to arrives with its history, which was
      // reported by whoever was watching then: counted from here, not from zero.
      run.spent = spentIn(text)
      this.runs.set(spec.run, run)
      if (spec.alreadyRunning) {
        const under = turnIn(text)
        taken = () => this.takenBack(run, missed, under)
      }
      return { ...run.handle }
    } finally {
      // On the next turn of the loop, once whoever took it has the run: where
      // it is first, then whatever reached it meanwhile.
      setTimeout(() => {
        taken()
        if (this.arriving.get(spec.run) === arriving) this.arriving.delete(spec.run)
        arrived()
      }, 0)
    }
  }

  /**
   * Run Grok as a child of ours rather than drawing a terminal: what the thing
   * you talk to needs, since Tade draws that conversation itself. A process
   * per turn (`grok -p`), on one session, so it is one conversation.
   *
   * Nothing is gated here — it is Tade's own interface — and the account
   * folder's hooks and tool server stand down for it (`headlessEnv`), except
   * that the tool server becomes the one it was handed, which is how it gets
   * Tade's own tools.
   */
  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    this.ready()
    await trustIn(this.opts.grokHome, spec.cwd).catch((err: unknown) =>
      this.opts.onWarning(
        `could not mark ${spec.cwd} as trusted for Grok, so it will not load its hooks there: ${(err as Error).message}`,
      ),
    )
    const run = this.runFor(spec, null, true)
    run.spent = await spentOn(spec.task, this.opts.grokHome)
    this.runs.set(spec.run, run)
    const more = (spec.extras?.mcp ?? []).slice(1)
    if (more.length > 0) {
      this.opts.onWarning(
        `Grok takes one tool server beside its own for a headless run, so ${more.length} more ${more.length === 1 ? 'was' : 'were'} not given to it: ${more.join(', ')}`,
      )
    }
    this.say(run, {
      type: 'started',
      sessionId: run.handle.sessionId,
      model: run.model,
      thinking: spec.thinking ? effortOf(spec.thinking) : null,
    })
    run.turn = 'idle'
    if (spec.prompt.trim()) await this.prompt(spec.run, spec.prompt, spec.images ?? [])
    else this.say(run, { type: 'idle' })
    return { ...run.handle }
  }

  private runFor(spec: WorkerSpec, channel: GrokChannel | null, headless: boolean): Run {
    return {
      handle: {
        run: spec.run,
        task: spec.task,
        sessionId: sessionIdFor(spec.task),
        startedAt: Date.now(),
        lane: spec.lane ?? null,
      },
      spec,
      channel,
      headless,
      child: null,
      stderr: '',
      error: '',
      aborting: false,
      cwd: spec.cwd,
      turn: 'starting',
      promptId: null,
      queued: [],
      naming: null,
      typing: Promise.resolve(),
      counting: Promise.resolve(),
      countTimer: null,
      held: new Map(),
      calls: new Map(),
      named: Boolean(spec.title),
      // Titled by its work already (`WorkerSpec.called`), so not by its opening prompt.
      titled: Boolean(spec.called),
      spent: noHarnessSpend(),
      model: spec.model ? modelName(spec.model) : null,
      context: null,
      reply: '',
      prompt: 0,
    }
  }

  /** One headless turn: a `grok -p` on the run's session, read to its end. */
  private async turnOf(entry: Run, message: string): Promise<void> {
    const spec = entry.spec
    const files = this.filesFor(spec)
    const going = await this.hasConversation(spec.task, spec.cwd)
    const rules = files.instructions ? readFileSync(files.instructions, 'utf8') : null
    const launch = {
      command: this.opts.bin,
      args: headlessArgs({
        prompt: message,
        session: sessionIdFor(spec.task),
        going,
        model: spec.model ? modelName(spec.model) : null,
        effort: spec.thinking ? effortOf(spec.thinking) : null,
        rules,
        extra: this.opts.args,
      }),
    }
    // It has no lane to carry on in and nobody could find it again, so it
    // does not outlive Tade — however Tade ends.
    const watched = reaped(launch)
    const child = spawn(watched.command, watched.args, {
      cwd: spec.cwd,
      env: headlessEnv(this.accountEnv(), spec, spec.extras?.mcp?.[0] ?? null),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    entry.child = child
    entry.stderr = ''
    entry.error = ''
    entry.reply = ''
    entry.turn = 'running'
    entry.aborting = false
    this.say(entry, { type: 'turn_started' })
    let ended = false
    let rest = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      rest += chunk
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        const line = rest.slice(0, end).trim()
        rest = rest.slice(end + 1)
        if (line && this.onHeadless(entry, line)) ended = true
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      entry.stderr = (entry.stderr + chunk).slice(-4_000)
    })
    await new Promise<void>((resolve) => {
      child.on('error', (err) => {
        if (!ended)
          this.say(entry, { type: 'failed', error: `could not start Grok: ${err.message}` })
        resolve()
      })
      child.on('exit', (code) => {
        if (this.runs.get(spec.run) !== entry) return resolve()
        if (!ended) {
          // A turn that ends with no `end` line says why from what it wrote,
          // rather than leaving a caller waiting on a turn that never comes.
          const aborted = entry.aborting
          if (!aborted && code !== 0) {
            this.say(entry, {
              type: 'failed',
              error: entry.error || exitReason(code, entry.stderr),
            })
          }
          this.say(entry, {
            type: 'turn_done',
            status: aborted ? 'aborted' : 'error',
            ...(aborted ? {} : { reason: entry.error || exitReason(code, entry.stderr) }),
          })
          entry.turn = 'idle'
          this.say(entry, { type: 'idle' })
        }
        resolve()
      })
    })
    if (entry.child === child) entry.child = null
  }

  /** What a headless turn says, line by line, as Tade's own signals; true at its end. */
  private onHeadless(entry: Run, line: string): boolean {
    const event = headlessEvent(line)
    if (!event) return false
    switch (event.kind) {
      case 'text':
        entry.reply += event.text
        this.say(entry, { type: 'message_delta', text: event.text })
        return false
      case 'call':
        this.say(entry, {
          type: 'tool_call',
          callId: event.callId,
          tool: event.tool,
          input: event.input,
          writes: writesOf(event.tool, event.input),
        })
        return false
      case 'result':
        this.say(entry, {
          type: 'tool_result',
          callId: event.callId,
          ok: event.ok,
          summary: event.summary,
        })
        return false
      case 'used':
        entry.prompt = event.prompt
        return false
      case 'error':
        entry.error = event.message
        return false
      case 'end': {
        if (event.model) entry.model = event.model
        const said = entry.reply.trim()
        if (said) this.say(entry, { type: 'message', text: said })
        const { input, output, cacheRead, cacheWrite } = event.usage
        const tokens = input + output + cacheRead + cacheWrite
        if (tokens > 0 || event.usd > 0) {
          this.say(entry, {
            type: 'usage',
            model: entry.model,
            input,
            output,
            cacheRead,
            cacheWrite,
            tokens,
            usd: this.priceable(event.usd),
          })
        }
        if (entry.prompt > 0) {
          const window = entry.model ? WINDOWS[entry.model] : undefined
          this.say(entry, {
            type: 'context',
            tokens: entry.prompt,
            percent: window ? Math.round((entry.prompt / window) * 100) : null,
          })
        }
        const aborted = entry.aborting
        const ok = event.stop === 'end_turn'
        this.say(entry, {
          type: 'turn_done',
          status: aborted ? 'aborted' : ok ? 'ok' : 'error',
          ...(!aborted && !ok ? { reason: entry.error || `the turn ended: ${event.stop}` } : {}),
        })
        entry.turn = 'idle'
        this.say(entry, { type: 'idle' })
        return true
      }
    }
  }

  /** Money, or nothing at all: only where this account is billed per token. */
  private priceable(usd: number): number {
    return this.capabilities.spend.usd === 'none' ? 0 : usd
  }

  async prompt(
    run: RunId,
    message: string,
    images: readonly WorkerImage[] = [],
    opts: { whenBusy?: 'steer' | 'queue' } = {},
  ): Promise<void> {
    const entry = this.require(run)
    const text = promptWithImages(message, images, this.filesDir(run))
    if (opts.whenBusy === 'queue') await this.queueOn(entry, text)
    else await this.steerOn(entry, text)
  }

  async steer(run: RunId, message: string): Promise<void> {
    await this.steerOn(this.require(run), message)
  }

  async queue(run: RunId, message: string): Promise<void> {
    await this.queueOn(this.require(run), message)
  }

  async decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.require(run)
    const waiter = entry.held.get(requestId)
    if (!waiter) throw new PermissionNotPendingError(requestId)
    entry.held.delete(requestId)
    waiter.resolve(decision)
  }

  async answer(run: RunId, callId: string, result: { ok: boolean; text: string }): Promise<void> {
    const entry = this.require(run)
    const waiter = entry.calls.get(callId)
    if (!waiter) return
    entry.calls.delete(callId)
    waiter.resolve(result)
  }

  /** What it is thinking with, as it last said. */
  async modelOf(run: RunId): Promise<WorkerModel | null> {
    const entry = this.require(run)
    return entry.model ? { provider: 'xai', id: entry.model } : null
  }

  async setModel(_run: RunId, _model: WorkerModel): Promise<void> {
    // Never typed as `/model`: a model chosen there is the session's, and
    // Tade starts an agent on the model the task says.
    throw new Error(`Grok ${this.capabilities.why.model}`)
  }

  async setThinking(_run: RunId, _level: ThinkingLevel): Promise<void> {
    throw new Error(`Grok ${this.capabilities.why.thinking}`)
  }

  async name(run: RunId, title: string): Promise<void> {
    const entry = this.require(run)
    const flat = title.replace(/\s+/g, ' ').trim()
    if (!flat) return
    entry.named = true
    if (entry.headless) return
    if (entry.turn === 'idle') await this.type(entry, `/rename ${flat}`)
    else entry.naming = flat
  }

  async abort(run: RunId): Promise<void> {
    const entry = this.require(run)
    if (entry.turn !== 'running') return
    entry.aborting = true
    if (entry.headless) {
      if (entry.child) endHeadless(entry.child)
      return
    }
    // Ctrl+C, as a key: Escape never stops a turn in Grok. It puts the prompt
    // back on its line when nothing was answered yet, where the next thing
    // typed would be joined onto it, so a second Ctrl+C clears the line —
    // which on a line already empty only arms Grok's "press again to quit".
    // Grok says a stopped turn with its StopCancelled hook, and not always:
    // the end of it is said here, and a late hook for it is not taken twice.
    await this.inTurn(entry, async () => {
      await this.keys(entry, '\x03')
      await new Promise((resolve) => setTimeout(resolve, CLEAR_AFTER_MS))
      await this.keys(entry, '\x03')
    })
    this.settle(entry, 'aborted')
  }

  async compact(run: RunId): Promise<void> {
    this.require(run)
    throw new Error(`Grok ${this.capabilities.why.compact}`)
  }

  async stop(run: RunId): Promise<void> {
    const entry = this.require(run)
    if (entry.child) endHeadless(entry.child)
    await this.forget(entry)
  }

  onSignal(run: RunId, listener: WorkerSignalListener): Unsubscribe {
    const set = this.listeners.get(run) ?? new Set()
    set.add(listener)
    this.listeners.set(run, set)
    return () => {
      set.delete(listener)
      if (set.size === 0 && this.listeners.get(run) === set) this.listeners.delete(run)
    }
  }

  async list(): Promise<WorkerHandle[]> {
    return [...this.runs.values()].map((run) => ({ ...run.handle }))
  }

  /**
   * Let go of every agent without ending it: they carry on in their lanes. A
   * headless turn has no lane to carry on in, so letting go of it is ending it.
   */
  async detach(): Promise<void> {
    for (const run of [...this.runs.values()]) {
      if (run.child) endHeadless(run.child)
      await this.forget(run)
    }
  }

  async shutdown(): Promise<void> {
    await this.detach()
  }

  // --- what the agent says ------------------------------------------------------

  private async onRequest(run: RunId, request: ChannelRequest): Promise<unknown> {
    await this.arriving.get(run)
    const entry = this.runs.get(run)
    // Nobody here to hear it, and said so, for a hook to keep what it had to say.
    if (!entry) return UNHEARD
    switch (request.kind) {
      case 'hook':
        return { output: await this.onHook(entry, request.event) }
      case 'status':
        this.onStatus(entry, request.status)
        return {}
      case 'done':
        this.say(entry, { type: 'done', summary: request.summary })
        return { ok: true }
      case 'call':
        return new Promise((resolve) => {
          entry.calls.set(request.callId, { resolve })
          this.say(entry, {
            type: 'extension_call',
            callId: request.callId,
            tool: request.tool,
            input: request.input,
          })
        })
      case 'cancel':
        if (entry.calls.has(request.callId)) {
          this.say(entry, { type: 'extension_cancelled', callId: request.callId })
        }
        return {}
    }
  }

  private async onHook(entry: Run, event: Record<string, unknown>): Promise<unknown> {
    const str = (key: string) => (typeof event[key] === 'string' ? (event[key] as string) : null)
    switch (event.hook_event_name) {
      case 'SessionStart': {
        // Each hook is a process of its own, so this can reach Tade after the
        // first prompt's: then the session has begun and a turn is running,
        // which it must not undo.
        this.begin(entry, str('session_id'))
        // Anything said before it could listen, said now it can.
        setTimeout(() => void this.flush(entry), 500).unref?.()
        return null
      }
      case 'UserPromptSubmit': {
        // What the turn before used, if it has not been counted yet.
        this.countSoon(entry, 0)
        this.begin(entry, str('session_id'))
        entry.turn = 'running'
        entry.promptId = str('promptId')
        this.say(entry, { type: 'turn_started' })
        const prompt = str('prompt') ?? ''
        if (!entry.named && !entry.titled) {
          const title = firstWords(prompt)
          if (title) {
            entry.titled = true
            this.say(entry, { type: 'titled', title, named: false })
          }
        }
        return null
      }
      case 'PreToolUse': {
        const callId = str('tool_use_id') ?? `${Date.now()}`
        const { tool, input } = toolOf(str('tool_name') ?? '', event.tool_input ?? {})
        this.say(entry, { type: 'tool_call', callId, tool, input, writes: writesOf(tool, input) })
        if (this.opts.approvals !== 'policy') return null
        const decision = await new Promise<PermissionDecision>((resolve) => {
          entry.held.set(callId, { resolve })
          this.say(entry, {
            type: 'permission_request',
            requestId: callId,
            tool,
            input,
            summary: describeToolCall(tool, input),
          })
        })
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.allow ? 'allow' : 'deny',
            permissionDecisionReason:
              decision.reason || (decision.allow ? 'approved in Tade' : 'refused in Tade'),
          },
        }
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const ok = event.hook_event_name === 'PostToolUse'
        this.say(entry, {
          type: 'tool_result',
          callId: str('tool_use_id') ?? '',
          ok,
          summary: ok ? '' : String(event.error ?? '').slice(0, 300),
        })
        return null
      }
      case 'Stop':
      case 'StopFailure':
      case 'StopCancelled': {
        // A Stop as the session closes has no turn behind it, and a word about
        // a turn other than the one running now — a cancelled one's, said
        // late — is not this one's end.
        if (!endsTurn(event) || entry.turn !== 'running') return null
        const prompt = str('promptId')
        if (prompt && entry.promptId && prompt !== entry.promptId) return null
        if (event.hook_event_name === 'Stop') {
          const said = str('last_assistant_message')
          if (said) this.say(entry, { type: 'message', text: said })
          this.countSoon(entry, COUNT_AFTER_MS)
          this.settle(entry, 'ok')
        } else if (event.hook_event_name === 'StopFailure') {
          this.countSoon(entry, COUNT_AFTER_MS)
          this.settle(entry, 'error', failureIn(event))
        } else {
          this.settle(entry, 'aborted')
        }
        return null
      }
      default:
        return null
    }
  }

  /** The session has begun: said once, whichever of its first hooks says so first. */
  private begin(entry: Run, sessionId: string | null): void {
    if (entry.turn !== 'starting') return
    entry.turn = 'idle'
    this.say(entry, { type: 'started', sessionId, model: entry.model, thinking: null })
  }

  /** Its status line's input: the one place Grok says how full the context is. */
  private onStatus(entry: Run, status: Record<string, unknown>): void {
    const model = (status.model as { id?: unknown } | undefined)?.id
    if (typeof model === 'string') entry.model = model
    const window = status.context_window as
      | { used_percentage?: unknown; context_tokens?: unknown }
      | undefined
    const percent = typeof window?.used_percentage === 'number' ? window.used_percentage : null
    if (percent !== null && percent !== entry.context) {
      entry.context = percent
      const tokens = typeof window?.context_tokens === 'number' ? window.context_tokens : null
      this.say(entry, { type: 'context', tokens, percent })
    }
  }

  /** Count what the session has used, after `wait`, once: one count at a time. */
  private countSoon(entry: Run, wait: number): void {
    if (entry.countTimer) clearTimeout(entry.countTimer)
    entry.countTimer = setTimeout(() => {
      entry.countTimer = null
      entry.counting = entry.counting.then(() => this.sayUsage(entry)).catch(() => {})
    }, wait)
    entry.countTimer.unref?.()
  }

  /**
   * What the turn used, from `grok usage` — the interface Grok promises for
   * a session's counts — said as the difference from what was said before;
   * its record (`updates.jsonl`) where `grok usage` could not answer.
   */
  private async sayUsage(entry: Run): Promise<void> {
    if (!this.runs.has(entry.handle.run)) return
    const now = await this.usageOf(entry.handle.task)
    const was = entry.spent
    const tokens = now.tokens - was.tokens
    if (tokens <= 0 && now.usd - was.usd <= 0) return
    entry.spent = now
    this.say(entry, {
      type: 'usage',
      model: now.model ?? entry.model,
      input: Math.max(0, now.input - was.input),
      output: Math.max(0, now.output - was.output),
      cacheRead: Math.max(0, now.cacheRead - was.cacheRead),
      cacheWrite: Math.max(0, now.cacheWrite - was.cacheWrite),
      tokens: Math.max(0, tokens),
      usd: this.priceable(Math.max(0, now.usd - was.usd)),
    })
  }

  /** A task's session's whole use so far, as `grok usage <id>` says it, or as its record does. */
  private async usageOf(task: string): Promise<HarnessSpend> {
    const ran = await runProgram(this.opts.bin, ['usage', sessionIdFor(task)], {
      timeoutMs: 15_000,
      env: this.accountEnv(),
    })
    if (ran.code === 0) {
      try {
        const said = JSON.parse(ran.stdout) as { turns?: unknown }
        if (Array.isArray(said.turns)) {
          const total = noHarnessSpend()
          for (const turn of said.turns) {
            if (typeof turn === 'object' && turn !== null) {
              addTurn(total, turn as Record<string, unknown>)
            }
          }
          return total
        }
      } catch {
        // An answer that is not its JSON: the record says the same.
      }
    }
    return spentOn(task, this.opts.grokHome)
  }

  /**
   * A run taken back, once whoever took it has it: the turn that ended while
   * Tade was away, said when it ended, then where it is now — in a turn where
   * what was left or its record says one is under way, idle otherwise —
   * unless a hook has said since.
   */
  private takenBack(
    entry: Run,
    missed: Missed | null,
    under: { since: number | null } | null,
  ): void {
    if (this.runs.get(entry.handle.run) !== entry) return
    if (missed) {
      const name = missed.event.hook_event_name
      const status = name === 'StopFailure' ? 'error' : name === 'StopCancelled' ? 'aborted' : 'ok'
      const reason = status === 'error' ? failureIn(missed.event) : undefined
      this.say(entry, { type: 'turn_done', status, ...(reason ? { reason } : {}) }, missed.at)
    }
    if (entry.turn !== 'starting') return
    const began = missed?.began ?? (under && !missed ? (under.since ?? Date.now()) : undefined)
    if (began !== undefined) {
      entry.turn = 'running'
      this.say(entry, { type: 'turn_started' }, began)
      return
    }
    entry.turn = 'idle'
    this.say(entry, { type: 'idle' })
    setTimeout(() => void this.flush(entry), 300).unref?.()
  }

  /** A turn is over: say how, then say whatever was waiting for it to be. */
  private settle(entry: Run, status: 'ok' | 'error' | 'aborted', reason?: string): void {
    entry.turn = 'idle'
    entry.promptId = null
    this.say(entry, { type: 'turn_done', status, ...(reason ? { reason } : {}) })
    this.say(entry, { type: 'idle' })
    // After Grok has drawn its prompt again.
    setTimeout(() => void this.flush(entry), 300).unref?.()
  }

  // --- what we say to it ----------------------------------------------------------

  private async steerOn(entry: Run, message: string): Promise<void> {
    if (entry.headless) return this.sendHeadless(entry, message)
    // Before the session has begun there is nothing to type into; once it has,
    // Grok itself holds what is typed during a turn until the turn ends.
    if (entry.turn === 'starting') entry.queued.push(message)
    else await this.type(entry, message)
  }

  private async queueOn(entry: Run, message: string): Promise<void> {
    await this.steerOn(entry, message)
  }

  /**
   * Say something to a headless run: a turn of its own, begun now or after the
   * one running. Said, not waited on — what the turn does arrives as signals.
   */
  private async sendHeadless(entry: Run, message: string): Promise<void> {
    if (entry.turn === 'running') {
      entry.queued.push(message)
      return
    }
    entry.turn = 'running'
    void this.turnOf(entry, message).then(() => {
      const next = entry.queued.splice(0).join('\n\n')
      if (next && this.runs.get(entry.handle.run) === entry) void this.sendHeadless(entry, next)
    })
  }

  private async flush(entry: Run): Promise<void> {
    if (entry.headless || entry.turn !== 'idle' || !this.runs.has(entry.handle.run)) return
    const naming = entry.naming
    entry.naming = null
    const said = entry.queued.splice(0).join('\n\n')
    if (naming) await this.type(entry, `/rename ${naming}`).catch(() => {})
    if (!said) return
    await this.type(entry, said).catch((err: unknown) =>
      this.say(entry, {
        type: 'problem',
        text: `could not say a queued message to Grok: ${(err as Error).message}`,
      }),
    )
  }

  /**
   * Type a message into its terminal and send it. Pasted, so a message of
   * several lines arrives as one rather than as a line and then the rest.
   */
  private type(entry: Run, text: string): Promise<void> {
    return this.inTurn(entry, async () => {
      await this.keys(entry, `\x1b[200~${text}\x1b[201~`)
      // Enter on its own, once the paste has landed.
      await new Promise((resolve) => setTimeout(resolve, 80))
      await this.keys(entry, '\r')
    })
  }

  /** Run something that types, after whatever is being typed already. */
  private inTurn(entry: Run, work: () => Promise<void>): Promise<void> {
    const next = entry.typing.then(work)
    entry.typing = next.catch(() => {})
    return next
  }

  private async keys(entry: Run, bytes: string): Promise<void> {
    if (!this.opts.type) throw new Error('there is no terminal to type into for Grok')
    await this.opts.type(entry.handle.run, bytes)
  }

  // --- bookkeeping ----------------------------------------------------------------

  /** Tell whoever listens, stamped now unless it happened earlier. */
  private say(
    entry: Run,
    signal: DistributiveOmit<WorkerSignal, 'run' | 'at'>,
    at = Date.now(),
  ): void {
    const full = { ...signal, run: entry.handle.run, at } as WorkerSignal
    for (const listener of this.listeners.get(entry.handle.run) ?? []) {
      try {
        listener(full)
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private require(run: RunId): Run {
    const entry = this.runs.get(run)
    if (!entry) throw new WorkerNotFoundError(run)
    return entry
  }

  private async forget(entry: Run): Promise<void> {
    this.runs.delete(entry.handle.run)
    if (entry.countTimer) clearTimeout(entry.countTimer)
    // Nothing left to answer them: a held call is refused rather than left
    // hanging, and Grok's hook says so under `policy`.
    for (const waiter of entry.held.values()) {
      waiter.resolve({ allow: false, reason: 'Tade let go of this agent' })
    }
    for (const waiter of entry.calls.values()) {
      waiter.resolve({ ok: false, text: 'Tade let go of this agent before the tool answered' })
    }
    entry.held.clear()
    entry.calls.clear()
    await entry.channel?.close().catch(() => {})
  }

  /**
   * The account folder made ready (`home.ts`): Tade's hooks, its tool server
   * and its status line in place. Your own `~/.grok` is shared into a folder
   * Tade makes for Grok's own sign-in, and into an added account's when asked.
   */
  private ready(share?: boolean): void {
    const parts: HomeParts = {
      node: process.execPath,
      hook: HOOK_PATH,
      statusline: STATUSLINE_PATH,
      mcp: MCP_PATH,
      gated: this.opts.approvals === 'policy',
    }
    const shares = share ?? this.opts.account === undefined
    try {
      const { theirStatusLine } = readyHome(this.opts.grokHome, parts, {
        share: shares ? ownGrokHome(this.opts.home) : null,
      })
      this.theirStatusLine = theirStatusLine
    } catch (err) {
      this.opts.onWarning(
        `could not make Grok's folder ready at ${this.opts.grokHome}, so its agents may not report to Tade: ${(err as Error).message}`,
      )
    }
  }

  /**
   * The environment Grok runs in for this account, for anything Tade asks of
   * it — with the folder made ready first, since a `grok` that finds no folder
   * makes one anybody can read.
   */
  private accountEnv(): NodeJS.ProcessEnv {
    this.ready()
    const env = { ...this.opts.env }
    delete env.XAI_API_KEY
    delete env.GROK_CODE_XAI_API_KEY
    delete env.GROK_CONFIG
    delete env.GROK_CONFIG_PATH
    for (const name of INHERITED_SESSION) delete env[name]
    env.GROK_HOME = this.opts.grokHome
    env.GROK_DISABLE_AUTOUPDATER = '1'
    return env
  }

  private runEnv(spec: WorkerSpec): Record<string, string> {
    const env: Record<string, string> = {
      [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
      [WORKER_ENV.approvals]: this.opts.approvals,
      [WORKER_ENV.run]: spec.run,
      [WORKER_ENV.task]: spec.task,
      GROK_HOME: this.opts.grokHome,
      // A binary that moves itself under a running lane is not a surprise
      // anybody wants: `grok update` is the person's to run.
      GROK_DISABLE_AUTOUPDATER: '1',
      ...COMPAT_OFF,
    }
    if (spec.extras?.tools) env[WORKER_ENV.tools] = spec.extras.tools
    if (spec.title) env[WORKER_ENV.title] = spec.title
    if (this.theirStatusLine) env.TADE_GROK_STATUSLINE = this.theirStatusLine
    return env
  }

  private filesDir(run: string): string {
    return join(this.opts.runDir, 'grok', runFolderName(run))
  }

  /**
   * What this run is handed that its account folder does not hold: the
   * instructions appended to Grok's own (`--rules`), with the skills Tade's
   * extensions ship named in them. Written the same every time, so the line
   * that reads them stays the same.
   */
  private filesFor(spec: WorkerSpec): { dir: string; instructions: string | null } {
    const dir = this.filesDir(spec.run)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const told = contextFor(spec)
    let instructions: string | null = null
    if (told) {
      instructions = join(dir, 'instructions.md')
      writeFileSync(instructions, told, { mode: 0o600 })
    }
    return { dir, instructions }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Where a run's supervision socket lives: hashed, because a long path fails to bind. */
export function runSocket(dir: string, run: string): string {
  return join(dir, `g-${createHash('sha1').update(run).digest('hex').slice(0, 12)}.sock`)
}

/** Why a turn failed, as its StopFailure hook said. */
function failureIn(event: Record<string, unknown>): string | undefined {
  const said = [event.error, event.errorDetails, event.last_assistant_message].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  )
  return said.join(': ') || undefined
}

/** A model as Grok takes it: its own name, never a provider's prefix. */
export function modelName(model: WorkerModel): string {
  return model.id.includes('/') ? (model.id.split('/').at(-1) ?? model.id) : model.id
}

/** A thinking level as Grok's `--reasoning-effort`: its `none` is Tade's `off`. */
export function effortOf(level: ThinkingLevel): string {
  if (level === 'off') return 'none'
  return EFFORTS.includes(level) ? level : 'medium'
}

/** The files a call of Grok's own tools writes: its editing tools, by their own field. */
export function writesOf(tool: string, input: unknown): string[] {
  if (!['search_replace', 'write', 'hashline_edit', 'StrReplace'].includes(tool)) return []
  const fields = (input ?? {}) as Record<string, unknown>
  const path = fields.file_path ?? fields.path ?? fields.target_file
  return typeof path === 'string' && path.length > 0 ? [path] : []
}

/** One line, exact enough to read back before approving. */
export function describeToolCall(tool: string, input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }
  switch (tool) {
    case 'run_terminal_command':
    case 'monitor':
    case 'Shell':
      return `${tool}: ${first('command')}`
    case 'search_replace':
    case 'write':
    case 'hashline_edit':
    case 'read_file':
      return `${tool} ${first('file_path', 'target_file', 'path')}`
    default:
      return `${tool} ${JSON.stringify(fields).slice(0, 200)}`
  }
}

/** A name from what was asked: its first line, politeness taken off, eight words at most. */
export function firstWords(text: string, words = 8): string {
  const line = text.split('\n').find((one) => one.trim()) ?? ''
  const plain = line
    .replace(/^(please\s+|can you\s+|could you\s+|would you\s+|let's\s+|help me\s+)+/i, '')
    .trim()
  return plain.split(/\s+/).filter(Boolean).slice(0, words).join(' ')
}

/**
 * What Tade's extensions give this agent, in words: their instructions, and
 * the skills they ship, named with where to read them.
 */
export function contextFor(spec: WorkerSpec): string {
  const parts: string[] = []
  if (spec.extras?.instructions?.trim()) parts.push(spec.extras.instructions.trim())
  const skills = spec.extras?.skills ?? []
  if (skills.length > 0) {
    const lines = skills.map((dir) => {
      const { name, description } = skillIn(dir)
      return `- ${name}: ${description} (read ${join(dir, 'SKILL.md')})`
    })
    parts.push(
      ['## Skills Tade gives you', 'Read one before doing what it covers.', ...lines].join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** A skill's name and what it is for, out of its own front matter. */
function skillIn(dir: string): { name: string; description: string } {
  const fallback = { name: basename(dir) || dir, description: 'a skill' }
  let text: string
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf8').slice(0, 8_000)
  } catch {
    return fallback
  }
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1]
  if (!front) return fallback
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(front)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  return {
    name: field('name') || fallback.name,
    description: field('description') || fallback.description,
  }
}
