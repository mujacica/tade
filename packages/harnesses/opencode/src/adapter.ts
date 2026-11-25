import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RequiredProgram, runProgram, type ThinkingLevel, type ToolEffect } from '@tade/core'
import { TOOLS_PATH } from '@tade/harnesses-acp'
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
  NO_HISTORY,
  noHarnessSpend,
  type PermissionDecision,
  type PlanLimits,
  promptWithImages,
  type RunId,
  reaped,
  runFolderName,
  SESSIONS_LISTED,
  SignalChannel,
  type SignIn,
  type SignInHere,
  signInHere,
  type ToolAnswer,
  WORKER_ENV,
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerImage,
  type WorkerModel,
  WorkerNotFoundError,
  type WorkerSignal,
  type WorkerSignalListener,
  type WorkerSpec,
} from '@tade/harnesses-core'
import { OPENCODE_CAPABILITIES } from './capabilities.ts'
import { configFor, modelRef } from './config.ts'
import { accountOf, goLimitsIn, type Integration, integrationsIn, planPays } from './plan.ts'
import {
  answerOf,
  compactionOf,
  type Exported,
  exportedIn,
  historyOf,
  renamedTo,
  sessionIdFor,
  spentIn,
} from './record.ts'

// Drives OpenCode V2 — anomalyco's `opencode`, unmodified — as a Tade worker,
// in a lane you can watch, signed in however its owner signed it in.
//
// Every OpenCode client talks to one shared background service by default,
// which keeps the environment it was started with and so would take nothing
// Tade hands a run. So a lane runs `opencode --standalone`: a private server,
// the TUI's own child, that lives and dies with the lane and reads
// `OPENCODE_CONFIG_CONTENT` (`config.ts`) — Tade's plugin, Tade's tool server,
// the instructions, the skills and, under approvals, a rule that makes every
// action ask. The plugin (`plugin/index.ts`) is the half inside: it reports
// over the run's socket the way pi's extension does, holds every permission
// OpenCode evaluates for Tade's answer, and says what Tade says to the agent
// through OpenCode's own session API, so nothing is typed into the terminal.
//
// The ledger is OpenCode's own record of the session, read through the one
// interface it promises for it, `opencode session export` (`record.ts`), and
// never its database.
//
// Headless — the thing you talk to — it is a process per turn on the same
// session (`opencode run -s <id>`), each its own private server with the same
// plugin in it, so the signals are the plugin's whichever way it runs. Tade
// says when a turn begins and when it is over, since a process that connects
// says `idle` before its turn has begun; nothing of it is gated.

/** The plugin's folder: OpenCode loads a local plugin from a folder, never from a file. */
export const PLUGIN_DIR = fileURLToPath(new URL('./plugin', import.meta.url))

/** The harness's name, as tasks, routes and the journal say it. */
export const OPENCODE = 'opencode'

/**
 * What a Claude Code tells the programs it runs about itself. OpenCode's
 * Claude Agent runs the person's `claude`, and started from inside a Claude
 * Code session that `claude` would take itself for that session's child.
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
 * What a person may have set for their own `opencode`, and would point a run
 * at another config or database than the account's: the account decides.
 */
const THEIRS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'OPENCODE_SERVER']

/** The folders an added account moves, which the agent's own shell commands must not see moved. */
const MOVED = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'OPENCODE_CONFIG_DIR'] as const

/** An API-key account's key, read from where Tade keeps it by the command that prints it. */
const KEY_LINE =
  'if [ -n "$key" ]; then OPENCODE_API_KEY="$(/bin/sh -c "$key")" || exit 1; export OPENCODE_API_KEY; fi'

/**
 * A server for one compaction of a headless conversation, and nothing else.
 *
 * OpenCode compacts only inside a server that is still running when the
 * compaction is done: one `opencode api session.compact --standalone` starts
 * takes the request and is gone before it has run, and no later server picks
 * it up. And `opencode run` cannot host one, because it will not start
 * without a message, which would be said into the conversation. So it is
 * `serve` — what `--standalone` itself runs inside every client — on a port
 * loopback chooses, behind a password Tade made for it (`OPENCODE_PASSWORD`),
 * with the run's config, so Tade's plugin is in it as it is in a turn. Seen in
 * OpenCode 2.4.1.
 */
const SERVER = [
  'bin="$1"; key="$2"; shift 2',
  `unset ${[...INHERITED_SESSION, ...THEIRS.filter((name) => name !== 'OPENCODE_CONFIG_CONTENT')].join(' ')}`,
  KEY_LINE,
  'exec "$bin" serve --hostname 127.0.0.1 --port 0',
].join('\n')

/**
 * How an agent is started or brought back: one line either way.
 *
 * `-s` both comes back to a session OpenCode has and starts one it has not,
 * but a TUI started on a session that does not exist yet stays on a blank one
 * until something is typed — so a prompt said through the session API would
 * land where nobody is looking, and the model the TUI picks before its config
 * has loaded is not the task's. So the line first makes the session, with the
 * task's model and name (`session.create`, which leaves one that exists as it
 * was), through a private server of its own that loads none of Tade's run, and
 * only then starts the TUI on it; one it could not make is said in the lane,
 * and Tade's plugin makes it instead.
 *
 * The opening instruction arrives last on the first launch only
 * (`--tade-opening <text>`), and is handed to the plugin rather than to the
 * TUI's `--prompt`: the TUI sends a prompt with whatever model it has chosen
 * by then, and the plugin sends it into the session made for it. An API-key
 * account's key is read from where Tade keeps it by the command that prints
 * it, never written on the line.
 */
const LAUNCHER = [
  'bin="$1"; create="$2"; key="$3"; shift 3',
  'n=$#; i=0; take=""; opening=""',
  'for arg in "$@"; do',
  '  i=$((i + 1))',
  '  if [ -n "$take" ]; then opening="$arg"; take=""',
  '  elif [ "$i" -eq "$((n - 1))" ] && [ "$arg" = --tade-opening ]; then take=1',
  '  else set -- "$@" "$arg"; fi',
  'done',
  'shift "$n"',
  `unset TADE_OPENCODE_OPENING ${[...INHERITED_SESSION, ...THEIRS.filter((name) => name !== 'OPENCODE_CONFIG_CONTENT')].join(' ')}`,
  'if [ -n "$opening" ]; then TADE_OPENCODE_OPENING="$opening"; export TADE_OPENCODE_OPENING; fi',
  KEY_LINE,
  'if [ -f "$create" ]; then',
  '  said="$(unset OPENCODE_CONFIG_CONTENT TADE_RUN_SOCKET TADE_OPENCODE_OPENING; "$bin" api session.create --standalone -d "$(cat "$create")" 2>&1)" ||',
  '    printf "%s\\n" "Tade could not make this agent’s OpenCode session first, so its plugin will: $said" >&2',
  'fi',
  'exec "$bin" --standalone "$@"',
].join('\n')

/** How long a headless turn is given to stop once it is told to, before it is ended. */
const ABORT_MS = 5_000

/** How long a headless turn's last words are waited for once its process has gone. */
const SETTLE_MS = 2_000

/** How long OpenCode's `auth list` is believed: one turn's usage asks it, so not every one. */
const CONNECTIONS_MS = 60_000

/** How long a compaction's server is given to say where it is listening. */
const SERVE_MS = 30_000

/** How long one question to that server is given; the compaction itself is `COMPACT_MS`. */
const API_MS = 60_000

/** How long a compaction is waited for: as long as the window waits for one. */
const COMPACT_MS = 10 * 60_000

export interface OpenCodeAdapterOptions {
  /** Directory for per-run files: the instructions, the session it makes, pictures. */
  runDir: string
  /** Where supervision sockets go; a short path, because a long one fails to bind. */
  socketDir?: string
  approvals?: 'bypass' | 'policy'
  /** The `opencode` to run. Found on the PATH by default. */
  bin?: string
  env?: NodeJS.ProcessEnv
  /** Extra arguments appended to every launch, for tests that need it told something. */
  args?: string[]
  onWarning?: (message: string) => void
  /** The account it runs as, when not OpenCode's own sign-in. */
  account?: HarnessAccount
  /** For tests: whose home OpenCode's own folders are found in. */
  home?: string
}

interface Run {
  handle: WorkerHandle
  spec: WorkerSpec
  channel: SignalChannel
  /** What reaches the run, in the order it arrived: a usage asks what pays for it first. */
  order: Promise<void>
  /** Said before the plugin was there to hear it, said once it is. */
  queued: Told[]
  model: string | null
  /** Run headless (`start`) rather than in a lane. */
  headless: Headless | null
}

/** A signal as Tade says it of a run, before it is stamped with the run and the time. */
type Said = WorkerSignal extends infer One
  ? One extends WorkerSignal
    ? Omit<One, 'run' | 'at'>
    : never
  : never

type Told =
  | { type: 'steer' | 'queue'; message: string }
  | { type: 'name'; title: string }
  | { type: 'model'; provider: string; id: string }

/** A headless run between and during its turns: a process each. */
interface Headless {
  child: ChildProcess | null
  /** The plugin of this turn's process has said it is there. */
  listening: boolean
  /** The plugin said this turn is over. */
  ended: boolean
  aborting: boolean
  /** The line made the session already, so later turns need not. */
  made: boolean
  stderr: string
  /** Said for after the turn that is running: the next turn's words. */
  waiting: string[]
  /**
   * A compaction in flight, whose process is `child`: whether its plugin has
   * said how full the context is since. Its execution ending is not a turn's.
   */
  compacting: { context: boolean } | null
}

export class OpenCodeAdapter implements WorkerAdapter {
  readonly id = OPENCODE
  /** It routes: every model is reached through a provider it is connected to, one per model. */
  readonly provider = null
  readonly capabilities = OPENCODE_CAPABILITIES

  readonly programs: readonly RequiredProgram[] = [
    {
      command: 'opencode',
      title: 'OpenCode',
      why: 'being the agent, for every task set to run in it',
      versionArgs: ['--version'],
      // V2 is its own package; `opencode-ai` is V1, whose server, plugins and
      // storage this harness does not speak.
      install: {
        npm: '@opencode/cli',
        instead: 'opencode.ai: curl -fsSL https://opencode.ai/v2/install | bash',
      },
    },
  ]

  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly opts: Required<Omit<OpenCodeAdapterOptions, 'account' | 'home'>> & {
    account: HarnessAccount | undefined
    home: string
  }
  private connections: { at: number; list: Promise<Integration[]> } | null = null
  private held: PlanLimits | null = null

  constructor(opts: OpenCodeAdapterOptions) {
    this.opts = {
      runDir: opts.runDir,
      socketDir: opts.socketDir ?? opts.runDir,
      approvals: opts.approvals ?? 'bypass',
      bin: opts.bin ?? 'opencode',
      env: opts.env ?? process.env,
      args: opts.args ?? [],
      onWarning: opts.onWarning ?? (() => {}),
      account: opts.account,
      home: opts.home ?? homedir(),
    }
  }

  async probe(): Promise<HarnessProbe> {
    const said = await runProgram(this.opts.bin, ['--version'], {
      timeoutMs: 15_000,
      env: this.accountEnv(),
    })
    if (said.code !== 0) {
      return {
        ok: false,
        version: null,
        problems: [
          said.missing
            ? `OpenCode is not installed (no ${this.opts.bin} on the PATH)`
            : `OpenCode would not say its version: ${said.stderr.trim() || `it exited ${said.code}`}`,
        ],
      }
    }
    const version = /\d+\.\d+\.\d+/.exec(said.stdout)?.[0] ?? null
    if (version && Number(version.split('.')[0]) < 2) {
      return {
        ok: false,
        version,
        problems: [
          `OpenCode ${version} is version 1, whose server and plugins Tade does not speak: Tade drives OpenCode 2 (@opencode/cli)`,
        ],
      }
    }
    const status = await this.account()
    const problems = status.signedIn
      ? []
      : [
          `OpenCode is not connected to any provider: sign in from Settings, or run ${this.signInLine()}`,
        ]
    return { ok: problems.length === 0, version, problems }
  }

  /** OpenCode's tools by what they do, by the names its agent calls them. */
  effectOf(tool: string): ToolEffect {
    switch (tool) {
      case 'read':
      case 'glob':
      case 'grep':
      case 'webfetch':
      case 'websearch':
      case 'skill':
      case 'session_search':
        return 'read'
      case 'edit':
      case 'write':
      case 'patch':
        return 'write'
      case 'shell':
      case 'execute':
        return 'exec'
      default:
        return 'other'
    }
  }

  conversationKey(task: string): string {
    return sessionIdFor(task)
  }

  /**
   * Whether OpenCode has anything said in the task's session. A session it
   * has not got is no conversation; one it could not export is thrown, since
   * read as none it would be told its first instruction a second time.
   */
  async hasConversation(task: string, cwd: string): Promise<boolean> {
    const record = await this.exportOf(sessionIdFor(task), cwd)
    return record?.messages.some((message) => message.type === 'user') ?? false
  }

  async spent(task: string, cwd: string): Promise<HarnessSpend> {
    const record = await this.exportOf(sessionIdFor(task), cwd)
    if (!record) return noHarnessSpend()
    const list = await this.integrations(cwd)
    return spentIn(record, (provider, usd) => planPays(provider, usd, list))
  }

  async history(task: string, cwd: string, ask: HistoryAsk): Promise<HistoryPage> {
    const record = await this.exportOf(sessionIdFor(task), cwd)
    return record ? historyOf(record, ask) : NO_HISTORY
  }

  async callAnswer(task: string, cwd: string, call: string): Promise<ToolAnswer | null> {
    const record = await this.exportOf(sessionIdFor(task), cwd)
    return answerOf(record, call)
  }

  /**
   * The sessions OpenCode keeps for a folder, as `opencode session list`
   * says them, newest first: each with its title, which OpenCode makes from
   * the first thing said in it.
   */
  async sessions(cwd: string, tasks: readonly string[]): Promise<HarnessSession[]> {
    const ran = await runProgram(
      this.opts.bin,
      ['session', 'list', '--format', 'json', '--standalone'],
      { cwd, timeoutMs: 30_000, env: this.accountEnv() },
    )
    if (ran.missing) return []
    if (ran.code !== 0) {
      throw new Error(`OpenCode would not list its sessions: ${ran.stderr.trim() || ran.code}`)
    }
    let listed: unknown
    try {
      listed = JSON.parse(ran.stdout)
    } catch (err) {
      throw new Error(`OpenCode listed its sessions in a shape Tade does not know: ${err}`)
    }
    if (!Array.isArray(listed)) return []
    const byKey = new Map(tasks.map((task) => [sessionIdFor(task), task]))
    const out: HarnessSession[] = []
    for (const raw of listed) {
      const one = raw as Record<string, unknown> | null
      if (typeof one?.id !== 'string') continue
      if (typeof one.directory === 'string' && !sameFolder(one.directory, cwd)) continue
      out.push({
        id: one.id,
        at: typeof one.updated === 'number' ? one.updated : 0,
        first: typeof one.title === 'string' ? one.title : '',
        task: (byKey.get(one.id) ?? null) as HarnessSession['task'],
      })
    }
    return out.sort((a, b) => b.at - a.at).slice(0, SESSIONS_LISTED)
  }

  /**
   * Have a task's agent carry on a session it did not start: a copy of it,
   * under the task's own id, so the one it came from is left as it was.
   * Never over a conversation the task already has.
   */
  async carrySession(session: string, task: string, cwd: string): Promise<boolean> {
    const id = sessionIdFor(task)
    if (session === id) return this.hasConversation(task, cwd)
    if (await this.hasConversation(task, cwd)) return false
    const record = await this.exportOf(session, cwd)
    if (!record || record.messages.length === 0) return false
    return this.importInto(this, renamedTo(record, id), cwd)
  }

  /**
   * What it can be started on, as `opencode models` lists them for this
   * account — which is what the providers it is connected to reach.
   */
  async models(): Promise<HarnessModel[]> {
    const ran = await runProgram(this.opts.bin, ['models', '--standalone'], {
      timeoutMs: 30_000,
      env: this.accountEnv(),
    })
    if (ran.code !== 0) return []
    const models: HarnessModel[] = []
    for (const line of ran.stdout.split('\n')) {
      const id = line.trim()
      const at = id.indexOf('/')
      if (at <= 0 || /\s/.test(id) || models.some((one) => one.id === id)) continue
      models.push({ id, provider: id.slice(0, at), name: id.slice(at + 1) })
    }
    return models
  }

  /**
   * "openai/gpt-5.5", "anthropic/claude-sonnet-5 high": a model is taken as
   * OpenCode spells it, `provider/model`, with `#variant` for how hard it
   * thinks — OpenCode says which it runs, and a list kept here would be out of
   * date the first time a model came out.
   */
  async resolveModel(said: string): Promise<ModelFound> {
    const words = said
      .trim()
      .replace(/^the\s+/i, '')
      .replace(/\s+model$/i, '')
    const spelled = words.replace(/\s+(?=[a-z0-9-]+$)/i, '#')
    const ref = modelRef(/^\S+\/\S+$/.test(words) ? words : spelled)
    if (ref && !/\s/.test(ref.providerID + ref.id)) {
      return {
        ok: true,
        provider: ref.providerID,
        id: `${ref.id}${ref.variant ? `#${ref.variant}` : ''}`,
      }
    }
    return {
      ok: false,
      reason: `OpenCode runs a model as provider/model, as opencode models lists them: which is "${said}"?`,
    }
  }

  /** How much of OpenCode Go is used, as it last said: nothing until it has been asked. */
  limits(): PlanLimits | null {
    return this.held
  }

  /**
   * Ask OpenCode how much of its Go plan is used (`GET /api/experimental/
   * usage/limits`, through a private server of this account's), and hold it.
   * Null where it said nothing of Go, or not in time.
   */
  async askLimits(timeoutMs: number): Promise<PlanLimits | null> {
    const ran = await runProgram(
      this.opts.bin,
      ['api', 'experimental.usage.limits', '--standalone'],
      { timeoutMs, env: this.accountEnv() },
    )
    if (ran.code !== 0 || ran.timedOut) return null
    const limits = goLimitsIn(ran.stdout, Date.now())
    if (limits) this.held = limits
    return limits
  }

  /** Who this account is connected as, as `opencode auth list` says it. */
  async account(): Promise<AccountStatus> {
    const none = { signedIn: false, who: null, plan: null, method: null, until: null }
    if (this.opts.account?.kind === 'api-key') {
      return {
        ...none,
        signedIn: Boolean(this.opts.account.key),
        method: 'api-key',
        problem: this.opts.account.key ? null : 'this account has no API key yet',
      }
    }
    const ran = await runProgram(
      this.opts.bin,
      ['auth', 'list', '--format', 'json', '--standalone'],
      { timeoutMs: 30_000, env: this.accountEnv() },
    )
    if (ran.missing) return { ...none, problem: 'OpenCode is not installed' }
    if (ran.code !== 0) {
      return {
        ...none,
        problem: `OpenCode would not say what it is signed in to: ${ran.stderr.trim() || `it exited ${ran.code}`}`,
      }
    }
    const list = integrationsIn(ran.stdout)
    this.connections = { at: Date.now(), list: Promise.resolve(list) }
    return accountOf(list)
  }

  /**
   * Its own sign-in, in a terminal you can see, in this account's folder:
   * OpenCode asks which provider to connect, and what it is given goes into
   * its own database — Tade never sees it. An API-key account has nothing to
   * sign in to.
   */
  signIn(here: SignInHere = signInHere(this.opts.env)): SignIn | null {
    if (this.opts.account?.kind === 'api-key') return null
    this.ready()
    return {
      launch: {
        command: this.opts.bin,
        args: ['auth', 'login', '--standalone'],
        env: this.accountVars(),
      },
      how: here.browser
        ? 'OpenCode asks which provider to connect. For a plan: OpenAI, then Sign in with ChatGPT, which opens your browser; GitHub Copilot, which shows a code to enter at github.com; or OpenCode Go, which asks for the key from opencode.ai/console. Pick one, finish there, then come back here.'
        : 'OpenCode asks which provider to connect. With no browser here, pick GitHub Copilot, which shows a code to enter at github.com on any device; OpenAI, then the ChatGPT device code; or OpenCode Go, which asks for the key from opencode.ai/console.',
    }
  }

  /** Its database: sessions and sign-ins together, which is where OpenCode keeps both. */
  records(): readonly string[] {
    return [join(this.dataDir(), 'opencode')]
  }

  /** Sign out of every provider this account is connected to, as OpenCode does it. */
  async signOut(): Promise<void> {
    const ran = await runProgram(
      this.opts.bin,
      ['auth', 'list', '--format', 'json', '--standalone'],
      { timeoutMs: 30_000, env: this.accountEnv() },
    )
    if (ran.code !== 0)
      throw new Error(ran.stderr.trim() || `opencode auth list exited ${ran.code}`)
    for (const integration of integrationsIn(ran.stdout)) {
      for (const connection of integration.connections) {
        if (connection.type !== 'credential') continue
        const out = await runProgram(
          this.opts.bin,
          ['auth', 'logout', integration.id, connection.id ?? connection.label, '--standalone'],
          { timeoutMs: 30_000, env: this.accountEnv() },
        )
        if (out.code !== 0) {
          throw new Error(
            out.stderr.trim() || `opencode auth logout ${integration.id} exited ${out.code}`,
          )
        }
      }
    }
    this.connections = null
  }

  /**
   * A folder of its own, private to you: OpenCode's database — its sessions
   * and its sign-ins — and its state. With `share`, your own OpenCode config
   * (providers, agents, plugins of your own) is read as it is; without, the
   * account has a config folder of its own as well.
   */
  async prepareAccount(share: boolean): Promise<void> {
    if (!this.opts.account) return
    this.ready()
    const dir = this.opts.account.dir
    const marker = join(dir, 'tade-opencode.json')
    writeFileSync(marker, `${JSON.stringify({ shareConfig: share })}\n`, { mode: 0o600 })
    if (!share) mkdirSync(join(dir, 'config'), { recursive: true, mode: 0o700 })
  }

  /** Copy a task's session into another account's database, where its OpenCode will find it. */
  async carryConversation(task: string, cwd: string, to: WorkerAdapter): Promise<boolean> {
    if (!(to instanceof OpenCodeAdapter) || to.dataDir() === this.dataDir()) return false
    const record = await this.exportOf(sessionIdFor(task), cwd)
    if (!record || record.messages.length === 0) return false
    return this.importInto(to, record, cwd)
  }

  /** Each run's folder of what launches it: never its session, which is the task's. */
  forgetRuns(runs: readonly RunId[]): Promise<RunId[]> {
    return forgetRunFiles(join(this.opts.runDir, OPENCODE), runs, (run) => [runFolderName(run)])
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
        'tade-opencode',
        this.opts.bin,
        files.create,
        key,
        '-s',
        sessionIdFor(spec.task),
        // Without approvals nothing is held, whatever a project's rules say
        // to ask; a rule that denies still denies. With them, Tade's plugin
        // answers every one.
        ...(this.opts.approvals === 'policy' ? [] : ['--auto']),
        ...this.opts.args,
      ],
      env: this.runEnv(spec, files, false),
      // Its first message, said at the first launch only, by the plugin into
      // the session the line made for it.
      ...(spec.prompt
        ? { opening: ['--tade-opening', promptWithImages(spec.prompt, spec.images, files.dir)] }
        : {}),
    }
  }

  /**
   * Listen for an agent about to be launched, or one that kept working while
   * the window was closed: the plugin dials the run's socket, made from the
   * run, and says where it is when it connects — a turn it finished while
   * nobody listened, then whether it is in one now.
   */
  async supervise(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    const channel = await SignalChannel.listen({
      path: runSocket(this.opts.socketDir, spec.run),
      run: spec.run,
      onSignal: (signal) => this.arrived(spec.run, signal),
      onWarning: this.opts.onWarning,
    })
    const run: Run = {
      handle: {
        run: spec.run,
        task: spec.task,
        sessionId: sessionIdFor(spec.task),
        startedAt: Date.now(),
        lane: spec.lane ?? null,
      },
      spec,
      channel,
      order: Promise.resolve(),
      queued: [],
      model: spec.model ? modelSaid(spec.model) : null,
      headless: null,
    }
    this.runs.set(spec.run, run)
    // What pays for its turns, asked before the first of them ends.
    void this.integrations(spec.cwd)
    return { ...run.handle }
  }

  /**
   * Run OpenCode as a child of ours rather than in a lane: what the thing you
   * talk to needs, since Tade draws that conversation itself. A process per
   * turn (`opencode run`) on the task's one session, so it is one
   * conversation, with Tade's plugin in each for the signals and for what is
   * said into a turn that is running. Nothing is gated: it is Tade's own
   * interface.
   */
  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    const handle = await this.supervise(spec)
    const entry = this.require(spec.run)
    entry.headless = {
      child: null,
      listening: false,
      ended: false,
      aborting: false,
      made: false,
      stderr: '',
      waiting: [],
      compacting: null,
    }
    this.tadeSays(entry, {
      type: 'started',
      sessionId: handle.sessionId,
      model: entry.model,
      thinking: null,
    })
    const opening = spec.prompt.trim()
      ? promptWithImages(spec.prompt, spec.images, this.filesDir(spec.run))
      : ''
    if (opening) this.turnOf(entry, opening)
    else this.tadeSays(entry, { type: 'idle' })
    return handle
  }

  async prompt(
    run: RunId,
    message: string,
    images: readonly WorkerImage[] = [],
    opts: { whenBusy?: 'steer' | 'queue' } = {},
  ): Promise<void> {
    const entry = this.require(run)
    const text = promptWithImages(message, images, this.filesDir(run))
    this.say(entry, opts.whenBusy === 'queue' ? 'queue' : 'steer', text)
  }

  async steer(run: RunId, message: string): Promise<void> {
    this.say(this.require(run), 'steer', message)
  }

  async queue(run: RunId, message: string): Promise<void> {
    this.say(this.require(run), 'queue', message)
  }

  async decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.require(run)
    entry.channel.send({
      type: 'decision',
      requestId,
      allow: decision.allow,
      reason: decision.reason ?? '',
    })
  }

  async answer(run: RunId, callId: string, result: { ok: boolean; text: string }): Promise<void> {
    this.require(run).channel.send({
      type: 'extension_result',
      callId,
      ok: result.ok,
      text: result.text,
    })
  }

  async setModel(run: RunId, model: WorkerModel): Promise<void> {
    const entry = this.require(run)
    const said = modelSaid(model)
    const ref = modelRef(said)
    if (!ref) throw new Error(`OpenCode runs a model as provider/model, and was given ${said}`)
    const told: Told = {
      type: 'model',
      provider: ref.providerID,
      id: `${ref.id}${ref.variant ? `#${ref.variant}` : ''}`,
    }
    // Headless, between turns there is no plugin to tell: the next turn's is.
    if (entry.headless && !entry.headless.listening) {
      entry.queued.push(told)
      return
    }
    if (!entry.channel.connected) throw new Error(`${run} is not connected: open its agent first`)
    entry.channel.send(told)
  }

  async setThinking(_run: RunId, _level: ThinkingLevel): Promise<void> {
    throw new Error(`OpenCode ${this.capabilities.why.thinking}`)
  }

  async modelOf(run: RunId): Promise<WorkerModel | null> {
    const entry = this.require(run)
    const ref = entry.model ? modelRef(entry.model) : null
    return ref ? { provider: ref.providerID, id: ref.id } : null
  }

  async name(run: RunId, title: string): Promise<void> {
    const entry = this.require(run)
    const flat = title.replace(/\s+/g, ' ').trim()
    if (!flat) return
    if (entry.headless && !entry.headless.listening) {
      entry.queued.push({ type: 'name', title: flat })
      return
    }
    if (!entry.channel.connected) throw new Error(`${run} is not connected: open its agent first`)
    entry.channel.send({ type: 'name', title: flat })
  }

  async abort(run: RunId): Promise<void> {
    const entry = this.require(run)
    const headless = entry.headless
    if (!headless) {
      entry.channel.send({ type: 'abort' })
      return
    }
    const child = headless.child
    if (!child) return
    headless.aborting = true
    // OpenCode stops the turn and keeps the session, and the process ends
    // with it; one that cannot be told, or does not stop, is ended.
    if (!headless.listening) {
      endHeadless(child)
      return
    }
    entry.channel.send({ type: 'abort' })
    setTimeout(() => {
      if (headless.child === child) endHeadless(child)
    }, ABORT_MS).unref?.()
  }

  /**
   * Compact a headless conversation between its turns, keeping its session:
   * a server of its own for the length of it (`SERVER`), asked through
   * OpenCode's own API — `session.compact`, then `experimental.session.wait`
   * until the session is idle again — and how it came out read back from the
   * record. Its plugin says how full the context is once OpenCode says the
   * compaction is over. Anything said meanwhile is the next turn.
   */
  async compact(run: RunId): Promise<void> {
    const entry = this.require(run)
    const headless = entry.headless
    if (!headless) throw new Error(`OpenCode ${this.capabilities.why.compact}`)
    if (headless.child) {
      throw new Error('OpenCode is in the middle of a turn, and compacts only between them')
    }
    const spec = entry.spec
    const session = sessionIdFor(spec.task)
    const password = randomBytes(24).toString('base64url')
    const key = this.opts.account?.kind === 'api-key' ? (this.opts.account.key ?? '') : ''
    const launch = reaped({
      command: '/bin/sh',
      args: ['-c', SERVER, 'tade-opencode', this.opts.bin, key],
    })
    const server = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env: {
        ...this.accountEnv(),
        ...spec.env,
        ...this.runEnv(spec, this.filesFor(spec), true),
        OPENCODE_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const compacting = { context: false }
    headless.child = server
    headless.compacting = compacting
    headless.listening = false
    headless.ended = false
    headless.aborting = false
    headless.stderr = ''
    server.stderr?.setEncoding('utf8')
    server.stderr?.on('data', (chunk: string) => {
      headless.stderr = (headless.stderr + chunk).slice(-4_000)
    })
    // `close` rather than `exit`: what it wrote as it ended is read by then.
    const gone = new Promise<void>((resolve) => {
      server.on('close', () => resolve())
      server.on('error', () => resolve())
    })
    try {
      const url = await listeningOn(server, gone, SERVE_MS)
      if (!url) {
        throw new Error(
          `OpenCode could not start a server to compact in: ${lastLine(headless.stderr) || 'it did not say why'}`,
        )
      }
      const api = (args: string[], timeoutMs: number) =>
        runProgram(
          this.opts.bin,
          ['api', '--server', url, ...args, '--param', `sessionID=${session}`],
          {
            cwd: existing(spec.cwd) ?? this.opts.home,
            timeoutMs,
            env: { ...this.accountEnv(), OPENCODE_PASSWORD: password },
          },
        )
      const asked = await api(['session.compact', '-d', '{}'], API_MS)
      const input = asked.code === 0 ? admitted(asked.stdout) : null
      if (!input) throw new Error(`OpenCode would not compact: ${saidBy(asked)}`)
      const waited = await api(['experimental.session.wait'], COMPACT_MS)
      if (waited.code !== 0 || waited.timedOut) {
        throw new Error(
          `OpenCode did not finish compacting: ${waited.timedOut ? `it had not after ${COMPACT_MS / 60_000} minutes` : saidBy(waited)}`,
        )
      }
      // How full it is now is the plugin's to say, as OpenCode says it ended.
      const deadline = Date.now() + SETTLE_MS
      while (!compacting.context && entry.channel.connected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      endHeadless(server)
      await gone
      await this.settled(entry)
      const outcome = compactionOf(await this.exportOf(session, spec.cwd), input)
      if (!outcome) throw new Error('OpenCode did not say how its compaction ended')
      if ('failed' in outcome) throw new Error(`OpenCode could not compact: ${outcome.failed}`)
    } finally {
      endHeadless(server)
      if (headless.child === server) headless.child = null
      headless.compacting = null
      headless.listening = false
      // What was said while it compacted is the next turn, as after a turn.
      const next = headless.waiting.splice(0).join('\n\n')
      if (next && this.runs.get(run) === entry) this.turnOf(entry, next)
    }
  }

  async stop(run: RunId): Promise<void> {
    const entry = this.runs.get(run)
    if (!entry) return
    // The process is the lane's: closing the lane is what ends it. A headless
    // turn has no lane, and is ended here.
    entry.channel.send({ type: 'shutdown' })
    if (entry.headless?.child) endHeadless(entry.headless.child)
    await this.forget(entry)
  }

  onSignal(run: RunId, listener: WorkerSignalListener): () => void {
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
      if (run.headless?.child) endHeadless(run.headless.child)
      await this.forget(run)
    }
  }

  async shutdown(): Promise<void> {
    await this.detach()
  }

  // --- what the agent says ------------------------------------------------------

  /** A signal from the plugin or the tool server, passed on in the order it came. */
  private arrived(run: RunId, signal: WorkerSignal): void {
    const entry = this.runs.get(run)
    if (!entry) return
    entry.order = entry.order
      .then(() => this.deliver(entry, signal))
      .catch((err: unknown) =>
        this.opts.onWarning(`an OpenCode agent's signal was lost: ${(err as Error).message}`),
      )
  }

  private async deliver(entry: Run, signal: WorkerSignal): Promise<void> {
    const headless = entry.headless
    if (headless) {
      // Its turns are Tade's to begin and end: each process's plugin says
      // `idle` as it connects, before the turn it was started for has begun.
      if (signal.type === 'idle' || signal.type === 'turn_started') return
      // A compaction runs as an execution of its own, and its end is not a
      // turn's: said as one, it would answer whatever was asked next.
      if (headless.compacting && signal.type === 'turn_done') return
      if (headless.compacting && signal.type === 'context') headless.compacting.context = true
      if (signal.type === 'turn_done') headless.ended = true
      if (signal.type === 'started') headless.listening = true
    }
    if (signal.type === 'started') {
      if (signal.model) entry.model = signal.model
      this.emit(entry, signal)
      // Anything said before it could listen, said now it can.
      for (const one of entry.queued.splice(0)) entry.channel.send(one)
      return
    }
    if (signal.type === 'usage') {
      if (signal.model) entry.model = signal.model
      const provider = signal.model?.includes('/') ? (signal.model.split('/')[0] ?? null) : null
      const list = await this.integrations(entry.spec.cwd)
      const plan = planPays(provider, signal.usd, list)
      // A plan's step costs nothing in OpenCode's record, which is a plan
      // paying and never money of nought: said so on the turn itself.
      this.emit(entry, { ...signal, usd: plan ? 0 : signal.usd, plan })
      return
    }
    this.emit(entry, signal)
  }

  /** What Tade says of a headless run itself, rather than its plugin. */
  private tadeSays(entry: Run, said: Said): void {
    this.emit(entry, { ...said, run: entry.handle.run, at: Date.now() } as WorkerSignal)
  }

  private emit(entry: Run, signal: WorkerSignal): void {
    for (const listener of this.listeners.get(entry.handle.run) ?? []) {
      try {
        listener(signal)
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  // --- what we say to it ----------------------------------------------------------

  private tell(entry: Run, type: 'steer' | 'queue', message: string): void {
    if (entry.channel.connected) entry.channel.send({ type, message })
    else entry.queued.push({ type, message })
  }

  /**
   * Something said to the agent. Headless, it begins a turn when none is
   * running; into one that is, it is steered by that turn's plugin — and
   * anything for after it, or for a turn that has already said it is over,
   * is the next turn's.
   */
  private say(entry: Run, type: 'steer' | 'queue', message: string): void {
    const headless = entry.headless
    if (!headless) this.tell(entry, type, message)
    else if (headless.compacting) headless.waiting.push(message)
    else if (!headless.child) this.turnOf(entry, message)
    else if (type === 'queue' || headless.ended) headless.waiting.push(message)
    else if (headless.listening) entry.channel.send({ type, message })
    else entry.queued.push({ type, message })
  }

  /** One headless turn: an `opencode run` on the task's session, until its process ends. */
  private turnOf(entry: Run, message: string): void {
    const headless = entry.headless
    if (!headless) return
    const spec = entry.spec
    const files = this.filesFor(spec)
    const key = this.opts.account?.kind === 'api-key' ? (this.opts.account.key ?? '') : ''
    // It has no lane to carry on in and nobody could find it again, so it
    // does not outlive Tade — however Tade ends.
    const launch = reaped({
      command: '/bin/sh',
      args: [
        '-c',
        LAUNCHER,
        'tade-opencode',
        this.opts.bin,
        headless.made ? '' : files.create,
        key,
        'run',
        '--format',
        'json',
        '-s',
        sessionIdFor(spec.task),
        '--auto',
        ...this.opts.args,
        '--',
        message,
      ],
    })
    headless.made = true
    headless.listening = false
    headless.ended = false
    headless.aborting = false
    headless.stderr = ''
    const env = { ...this.accountEnv(), ...spec.env, ...this.runEnv(spec, files, true) }
    const child = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    })
    headless.child = child
    this.tadeSays(entry, { type: 'turn_started' })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      headless.stderr = (headless.stderr + chunk).slice(-4_000)
    })
    let over = false
    const finish = (said: Said | null) => {
      if (over) return
      over = true
      void this.settled(entry).then(() => {
        if (headless.child === child) headless.child = null
        if (this.runs.get(spec.run) !== entry) return
        if (said) this.tadeSays(entry, said)
        if (!headless.ended) {
          // A turn whose plugin never said it was over says why from what the
          // process wrote, rather than leaving a caller waiting on it.
          const reason = lastLine(headless.stderr) || 'OpenCode ended the turn without saying why'
          this.tadeSays(entry, {
            type: 'turn_done',
            status: headless.aborting ? 'aborted' : 'error',
            ...(headless.aborting ? {} : { reason }),
          })
        }
        // What was said for after it, and what its plugin never got to hear,
        // is the next turn; a name or a model is still the next plugin's.
        const unheard = entry.queued.flatMap((one) =>
          one.type === 'steer' || one.type === 'queue' ? [one.message] : [],
        )
        entry.queued = entry.queued.filter((one) => one.type !== 'steer' && one.type !== 'queue')
        const next = [...unheard, ...headless.waiting.splice(0)].join('\n\n')
        if (next) this.turnOf(entry, next)
        else this.tadeSays(entry, { type: 'idle' })
      })
    }
    child.on('error', (err) =>
      finish({ type: 'problem', text: `could not start OpenCode: ${err.message}` }),
    )
    child.on('exit', () => finish(null))
  }

  /**
   * Once a headless turn's process has gone, what it said is read to its end:
   * its plugin's socket closes after its last line, which may be after the
   * process is seen to exit.
   */
  private async settled(entry: Run): Promise<void> {
    const deadline = Date.now() + SETTLE_MS
    while (entry.channel.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await entry.order
  }

  // --- bookkeeping ----------------------------------------------------------------

  private require(run: RunId): Run {
    const entry = this.runs.get(run)
    if (!entry) throw new WorkerNotFoundError(run)
    return entry
  }

  private async forget(entry: Run): Promise<void> {
    this.runs.delete(entry.handle.run)
    await entry.channel.close().catch(() => {})
  }

  /** What this account is connected to, asked at most once a minute. */
  private integrations(cwd: string): Promise<Integration[]> {
    const now = Date.now()
    if (this.connections && now - this.connections.at < CONNECTIONS_MS) {
      return this.connections.list
    }
    const list = runProgram(this.opts.bin, ['auth', 'list', '--format', 'json', '--standalone'], {
      cwd,
      timeoutMs: 30_000,
      env: this.accountEnv(),
    }).then((ran) => (ran.code === 0 ? integrationsIn(ran.stdout) : []))
    this.connections = { at: now, list }
    return list
  }

  /** A session as OpenCode exports it; null where it has none by that id. */
  private async exportOf(id: string, cwd: string): Promise<Exported | null> {
    const ran = await runProgram(this.opts.bin, ['session', 'export', id, '--standalone'], {
      cwd: existing(cwd) ?? this.opts.home,
      timeoutMs: 60_000,
      env: this.accountEnv(),
    })
    if (ran.missing) return null
    if (ran.code !== 0) {
      // A session it does not have is no record, which is an empty one.
      if (/not\s*found/i.test(`${ran.stderr}${ran.stdout}`)) return null
      throw new Error(`OpenCode would not export ${id}: ${ran.stderr.trim() || ran.code}`)
    }
    return exportedIn(ran.stdout)
  }

  /** Put a record into an account's database, as OpenCode imports one. */
  private async importInto(to: OpenCodeAdapter, record: Exported, cwd: string): Promise<boolean> {
    const dir = await mkdtemp(join(tmpdir(), 'tade-opencode-'))
    try {
      const file = join(dir, 'session.json')
      await writeFile(file, JSON.stringify(record), { mode: 0o600 })
      const ran = await runProgram(to.opts.bin, ['session', 'import', file, '--standalone'], {
        cwd: existing(cwd) ?? to.opts.home,
        timeoutMs: 60_000,
        env: to.accountEnv(),
      })
      if (ran.code !== 0) {
        this.opts.onWarning(
          `OpenCode would not take session ${String(record.info.id)} in: ${ran.stderr.trim() || ran.code}`,
        )
        return false
      }
      return true
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Where this account's OpenCode keeps its data: the account's own, or the person's. */
  private dataDir(): string {
    if (this.opts.account) return join(this.opts.account.dir, 'data')
    return this.opts.env.XDG_DATA_HOME || join(this.opts.home, '.local', 'share')
  }

  /** Whether an added account reads its owner's own OpenCode config. */
  private sharesConfig(): boolean {
    if (!this.opts.account) return true
    const marker = join(this.opts.account.dir, 'tade-opencode.json')
    // An account readied before it said either way shares, as every account did.
    if (!existsSync(marker)) return true
    try {
      const said = JSON.parse(readFileSync(marker, 'utf8')) as { shareConfig?: unknown }
      return said.shareConfig !== false
    } catch (err) {
      this.opts.onWarning(
        `could not read whether OpenCode's account ${this.opts.account.name} shares your config, so it does: ${(err as Error).message}`,
      )
      return true
    }
  }

  /**
   * The variables that make OpenCode this account's: an added account's own
   * data and state folders — its database is there, with its sign-ins — and
   * its own config folder where it shares none. OpenCode's own sign-in is
   * the person's own folders, untouched.
   */
  private accountVars(): Record<string, string> {
    const vars: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: '1' }
    const account = this.opts.account
    if (!account) return vars
    vars.XDG_DATA_HOME = join(account.dir, 'data')
    vars.XDG_STATE_HOME = join(account.dir, 'state')
    if (!this.sharesConfig()) vars.OPENCODE_CONFIG_DIR = join(account.dir, 'config')
    return vars
  }

  /** The environment OpenCode runs in for anything Tade asks of it outside a lane. */
  private accountEnv(): NodeJS.ProcessEnv {
    const env = { ...this.opts.env }
    for (const name of [...INHERITED_SESSION, ...THEIRS]) delete env[name]
    // Tade's own run is never another process's: a lane's socket and session stay the lane's.
    delete env[WORKER_ENV.socket]
    delete env.TADE_OPENCODE_SESSION
    return { ...env, ...this.accountVars() }
  }

  /** What a run is told: a lane's is gated under approvals, a headless one's never. */
  private runEnv(spec: WorkerSpec, files: Files, headless: boolean): Record<string, string> {
    const gated = !headless && this.opts.approvals === 'policy'
    const vars = this.accountVars()
    // What the agent's own commands see of the folders the account moved:
    // as they were, or not set, put back by the plugin.
    const shell: Record<string, string | null> = {}
    for (const name of MOVED) {
      if (vars[name] !== undefined) shell[name] = this.opts.env[name] ?? null
    }
    const env: Record<string, string> = {
      ...vars,
      [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
      [WORKER_ENV.approvals]: gated ? 'policy' : 'bypass',
      [WORKER_ENV.run]: spec.run,
      [WORKER_ENV.task]: spec.task,
      TADE_OPENCODE_SESSION: sessionIdFor(spec.task),
      // What the session is made with, should the line not have made it.
      ...(spec.model ? { TADE_OPENCODE_MODEL: modelSaid(spec.model) } : {}),
      ...(spec.called?.trim() ? { [WORKER_ENV.called]: spec.called.trim() } : {}),
      TADE_OPENCODE_SHELL_ENV: JSON.stringify(shell),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(
        configFor({
          plugin: PLUGIN_DIR,
          // Headless, Tade's own tool server is among those it was handed.
          tools: headless ? null : { command: process.execPath, args: [TOOLS_PATH] },
          servers: spec.extras?.mcp ?? [],
          instructions: files.instructions,
          skills: spec.extras?.skills ?? [],
          gated,
          onWarning: this.opts.onWarning,
        }),
      ),
    }
    if (spec.extras?.tools) env[WORKER_ENV.tools] = spec.extras.tools
    if (spec.title) env[WORKER_ENV.title] = spec.title
    return env
  }

  private filesDir(run: string): string {
    return join(this.opts.runDir, OPENCODE, runFolderName(run))
  }

  /**
   * What this run is handed beside its config: the instructions appended to
   * OpenCode's own, and the session the line makes before the TUI opens —
   * with the task's model and name. Written the same every time, so the line
   * that reads them stays the same.
   */
  private filesFor(spec: WorkerSpec): Files {
    const dir = this.filesDir(spec.run)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let instructions: string | null = null
    const told = spec.extras?.instructions?.trim()
    if (told) {
      instructions = join(dir, 'instructions.md')
      writeFileSync(instructions, `${told}\n`, { mode: 0o600 })
    }
    const ref = spec.model ? modelRef(modelSaid(spec.model)) : null
    const title = spec.title?.trim() || spec.called?.trim()
    const create = join(dir, 'session.json')
    writeFileSync(
      create,
      JSON.stringify({
        id: sessionIdFor(spec.task),
        ...(title ? { title } : {}),
        ...(ref ? { model: ref } : {}),
      }),
      { mode: 0o600 },
    )
    return { dir, instructions, create }
  }

  /** The account's folder made, private to you, before anything runs `opencode` in it. */
  private ready(): void {
    const account = this.opts.account
    if (!account) return
    try {
      for (const sub of ['', 'data', 'state']) {
        mkdirSync(join(account.dir, sub), { recursive: true, mode: 0o700 })
      }
      chmodSync(account.dir, 0o700)
    } catch (err) {
      this.opts.onWarning(
        `could not make OpenCode's folder ready at ${account.dir}: ${(err as Error).message}`,
      )
    }
  }

  /** The sign-in, as a line a person could type themselves. */
  private signInLine(): string {
    const vars = Object.entries(this.accountVars())
      .filter(([name]) => name !== 'OPENCODE_DISABLE_AUTOUPDATE')
      .map(([name, value]) => `${name}=${value}`)
    return [...vars, basename(this.opts.bin), 'auth', 'login', '--standalone'].join(' ')
  }
}

interface Files {
  dir: string
  instructions: string | null
  create: string
}

/** Where a run's supervision socket lives: hashed, because a long path fails to bind. */
export function runSocket(dir: string, run: string): string {
  return join(dir, `o-${createHash('sha1').update(run).digest('hex').slice(0, 12)}.sock`)
}

/** A model as OpenCode spells it: `provider/model`, however it was handed over. */
export function modelSaid(model: WorkerModel): string {
  if (model.id.includes('/') || !model.provider) return model.id
  return `${model.provider}/${model.id}`
}

/** The last thing a process wrote that is not blank. */
function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1)?.trim() ?? ''
}

/** What a question to OpenCode came back with when it failed, in its words. */
function saidBy(ran: { code: number; stdout: string; stderr: string }): string {
  return lastLine(ran.stderr) || lastLine(ran.stdout) || `it ended with ${ran.code}`
}

/**
 * The id `session.compact` filed the request under: what the record names the
 * compaction by. Null where its answer names none; an answer that is not JSON
 * at all is said as that, since the compaction cannot be followed without it.
 */
function admitted(stdout: string): string | null {
  let said: unknown
  try {
    said = JSON.parse(stdout)
  } catch (err) {
    throw new Error(
      `OpenCode answered session.compact with something that is not JSON (${(err as Error).message}): ${lastLine(stdout) || 'nothing'}`,
    )
  }
  const data = (said as { data?: { id?: unknown } } | null)?.data
  return typeof data?.id === 'string' && data.id ? data.id : null
}

/** Where a server Tade started says it listens, once it has; null if it ended or never said. */
function listeningOn(
  server: ChildProcess,
  gone: Promise<void>,
  ms: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let said = ''
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
    server.stdout?.setEncoding('utf8')
    server.stdout?.on('data', (chunk: string) => {
      said = (said + chunk).slice(-4_000)
      const url = /listening on (https?:\/\/\S+)/.exec(said)?.[1]
      if (url) {
        clearTimeout(timer)
        resolve(url)
      }
    })
    void gone.then(() => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

/** A folder that is there, or null: a command is never started in one that is gone. */
function existing(dir: string): string | null {
  return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : null
}

/** Whether two paths name one folder, as macOS's `/private` makes some say it twice. */
function sameFolder(a: string, b: string): boolean {
  const plain = (path: string) => path.replace(/^\/private(?=\/)/, '').replace(/\/+$/, '')
  return plain(a) === plain(b)
}
