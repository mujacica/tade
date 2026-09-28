import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { RequiredProgram, ThinkingLevel, ToolEffect, Unsubscribe } from '@tade/core'
import {
  type AccountStatus,
  type HarnessAccount,
  type HarnessModel,
  type HarnessProbe,
  type HarnessSpend,
  type LaunchSpec,
  type ModelFound,
  type PermissionDecision,
  PermissionNotPendingError,
  type PlanLimits,
  type RunId,
  reaped,
  type SignIn,
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
import { type ChannelRequest, ClaudeChannel } from './channel.ts'
import {
  defaultConfigDir,
  interruptedIn,
  sessionIdFor,
  spentIn,
  spentOn,
  transcriptFor,
} from './transcript.ts'
import { trustFolder } from './trust.ts'

// Drives Claude Code as a Tade worker: the official `claude`, unmodified, in a
// lane you can watch, signed in however its owner signed it in.
//
// Nothing of ours runs inside it the way the supervision extension runs inside
// pi. What it tells us arrives through hooks, its status line and an MCP
// server, all handed to it for this run alone (`--settings`, `--mcp-config`)
// so nothing in anybody's own configuration is touched. What we tell it is
// typed into its terminal, as a person would — which is also why some things
// are only possible between turns, or by starting it again.

export const HOOK_PATH = fileURLToPath(new URL('./hook.ts', import.meta.url))
export const STATUSLINE_PATH = fileURLToPath(new URL('./statusline.ts', import.meta.url))
export const MCP_PATH = fileURLToPath(new URL('./mcp.ts', import.meta.url))

/** The harness's name, as tasks, routes and the journal say it. */
export const CLAUDE_CODE = 'claude-code'

/** The thinking levels Claude Code can be told, as its `--effort`. */
const EFFORTS: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** What of your own Claude Code a second account is given, when shared: never its sign-in. */
const SHARED = [
  'settings.json',
  'CLAUDE.md',
  'skills',
  'agents',
  'commands',
  'plugins',
  'output-styles',
  'keybindings.json',
]

/** The names Claude Code keeps for the newest of each line of models. */
const ALIASES = [
  { alias: 'opus', name: 'Opus, the newest' },
  { alias: 'sonnet', name: 'Sonnet, the newest' },
  { alias: 'fable', name: 'Fable, the newest' },
  { alias: 'haiku', name: 'Haiku, the newest' },
]

/** Why a headless run ended, from what it wrote before it did. */
export function exitReason(code: number | null, stderr: string): string {
  const said = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return said || `Claude Code exited with code ${code ?? 'unknown'}`
}

/** How long after its status line settles the transcript is counted. */
const COUNT_AFTER_MS = 1_000

/** Tade's own tools, as Claude Code names them: `mcp__<server>__<tool>`. */
const OURS = 'mcp__tade__'

/**
 * What a Claude Code tells the programs it runs about itself. Started from
 * inside one — Tade opened from its terminal, or from an editor that hosts it
 * — an agent would take itself for that session's child, and a child keeps no
 * transcript of its own: nothing to come back to, nothing to count. Settings a
 * person exported on purpose (`CLAUDE_CODE_USE_BEDROCK`, …) are left alone.
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
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
]

/**
 * How an agent is started or brought back: one line either way.
 *
 * Claude Code refuses to start a session under an id it already has, and
 * refuses to resume one it does not, so the line looks before it leaps — for
 * the transcript with this session's name — and says whichever is true. That
 * keeps the line Tade writes down the one that reattaches, wherever it is run
 * from. An inherited Anthropic key is dropped: in a terminal Claude Code
 * stops to ask whether to use it, and the account the agent was given is the
 * one that should pay.
 */
const LAUNCHER = [
  'id="$1"; look="$2"; name="$3"; bin="$4"; shift 4',
  `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ${INHERITED_SESSION.join(' ')}`,
  'if [ -n "$(find "$look/projects" -maxdepth 2 -name "$id.jsonl" -print 2>/dev/null | head -n 1)" ]; then',
  '  exec "$bin" --resume "$id" "$@"',
  'fi',
  'if [ -n "$name" ]; then exec "$bin" --session-id "$id" --name "$name" "$@"; fi',
  'exec "$bin" --session-id "$id" "$@"',
].join('\n')

export interface ClaudeAdapterOptions {
  /** Directory for per-run files: the settings, the tool server's config, the instructions. */
  runDir: string
  /** Where supervision sockets go; a short path, because a long one fails to bind. */
  socketDir?: string
  approvals?: 'bypass' | 'policy'
  /** The `claude` to run. Found on the PATH by default. */
  bin?: string
  /**
   * The account: the folder Claude Code keeps its sign-in, settings and
   * transcripts in. Its own default, `~/.claude`, unless another was chosen.
   */
  configDir?: string
  env?: NodeJS.ProcessEnv
  /** Extra arguments appended to every launch, for tests that need it told something. */
  args?: string[]
  /** Type into an agent's terminal: how anything is said to it, since it listens nowhere else. */
  type?: (run: RunId, text: string) => Promise<void>
  onWarning?: (message: string) => void
  /**
   * The account it runs as, when not the default: its folder becomes the
   * config folder, and an API-key account is paid for by the key its command
   * prints.
   */
  account?: HarnessAccount
  /** For tests: whose home the default account is in. */
  home?: string
}

interface Waiter<T> {
  resolve: (value: T) => void
}

interface Run {
  handle: WorkerHandle
  /** The socket its hooks report over, for an agent in a lane. */
  channel: ClaudeChannel | null
  /** The process, for a headless run: the one Tade draws itself. */
  child?: ChildProcess | null
  /** The last it wrote to standard error, which is where it says why it would not start. */
  stderr?: string
  /** Tade asked for the turn to stop, so the end of it is not a failure. */
  aborting?: boolean
  cwd: string
  /** Whether a turn is running, as its hooks said. `starting` until the session has begun. */
  turn: 'starting' | 'running' | 'idle'
  /** Said while a turn ran, to be said once it ends. */
  queued: string[]
  /** A name chosen while a turn ran, given once it ends. */
  naming: string | null
  /**
   * What is being typed into its terminal, in order. Everything typed goes
   * through here: a paste and its Enter from two callers at once would land
   * as one message sent twice and another never sent.
   */
  typing: Promise<void>
  held: Map<string, Waiter<PermissionDecision>>
  calls: Map<string, Waiter<{ ok: boolean; text: string }>>
  /** A name was chosen by a person, so none is guessed. */
  named: boolean
  titled: boolean
  transcript: string | null
  /** What the transcript had spent when we last said, so each turn sends only the difference. */
  spent: HarnessSpend
  /** What the session said it had cost when we last said. Its process's own running total. */
  cost: number
  model: string | null
  context: number | null
  /** A count of the transcript waiting to be taken, once what was said has been written. */
  counting: NodeJS.Timeout | null
}

/**
 * What Claude Code can do, on this sign-in.
 *
 * Everything here is the same whoever is signed in but the money, and the
 * money is the whole of the difference: a subscription charges a flat fee, so
 * there is no price per turn to report and Claude Code's own running estimate
 * is a guess at what an API would have charged rather than a bill anybody
 * gets. Totalled as money it is a large number that means nothing. Against an
 * API key that same estimate is what the account will be charged.
 */
function claudeCapabilities(account: HarnessAccount | undefined): WorkerCapabilities {
  return {
    permissionGate: true,
    // Typed while a turn runs, Claude Code takes it at its next tool call and
    // answers it in the same turn: a real steer.
    steer: 'live',
    // Held until the turn's Stop hook, then typed.
    queue: 'live',
    abort: 'live',
    model: 'restart',
    thinking: 'restart',
    thinkingLevels: EFFORTS,
    rename: 'idle',
    visibleUi: true,
    resume: true,
    // A resumed session starts on whatever the account's default is, so the
    // model it was on has to be said again.
    resumeKeeps: false,
    // `API Error: Your computer went to sleep mid-response.` and back to the
    // prompt, with the session intact: it needs telling, not restarting.
    continues: true,
    images: 'path',
    done: true,
    nativeExtensions: false,
    skills: true,
    tools: true,
    mcp: true,
    // `-p --input-format stream-json`: a conversation over its own protocol,
    // which is how Tade draws the thing you talk to.
    headless: true,
    // A plan has no price per turn, so on a subscription there is no money
    // to report at all and the plan's windows are what is used up. Against an
    // API key the same estimate is a bill somebody gets, and is worth saying.
    spend: {
      usd: account?.kind === 'api-key' ? 'estimate' : 'none',
      tokens: true,
      limits: 'while-working',
    },
    accounts: true,
    why: {
      model:
        'takes a model only when it starts, so changing it starts the agent again, keeping the conversation',
      thinking:
        'takes how hard to think only when it starts, so changing it starts the agent again, keeping the conversation',
      rename: 'renames a session only between turns, so a new name waits for the turn to end',
      images: 'is shown a picture as a file it is told about, since its terminal cannot take one',
      nativeExtensions:
        'has no place for pi extensions: their tools and skills still reach it, their own code does not',
      spend:
        account?.kind === 'api-key'
          ? 'prices a session only as its own estimate, never against a catalog'
          : "is paid for by a plan, which has no price per turn: what is used up is the plan's windows",
      limits: 'reports it as one of its agents replies, so there is nothing to show until one has',
    },
  }
}

export class ClaudeAdapter implements WorkerAdapter {
  readonly id = CLAUDE_CODE
  /**
   * Anthropic, through Claude Code's own sign-in. It reaches no router and
   * takes no provider in front of a model name, so a route that asks for one
   * is asking for something this harness cannot do — and every Claude Code run
   * in this machine's journal was nonetheless filed under `openrouter`,
   * because the route said so and nobody asked the harness.
   */
  readonly provider = 'anthropic'
  /**
   * Built here rather than declared flat, because what its money is worth
   * depends on how this account pays: see `claudeCapabilities`.
   */
  readonly capabilities: WorkerCapabilities

  readonly programs: readonly RequiredProgram[] = [
    {
      command: 'claude',
      title: 'Claude Code',
      why: 'being the agent, for every task set to run in it',
      versionArgs: ['--version'],
      // npm and nothing else: it is the install Anthropic publishes, and the
      // Homebrew casks called `claude` and `claude-code` are not the same
      // thing as each other, let alone reliably this.
      install: { npm: '@anthropic-ai/claude-code' },
    },
  ]

  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly opts: Required<Omit<ClaudeAdapterOptions, 'type' | 'home' | 'account'>> & {
    type: ClaudeAdapterOptions['type']
    home: string
    account: HarnessAccount | undefined
  }
  private planLimits: PlanLimits | null = null

  constructor(opts: ClaudeAdapterOptions) {
    const home = opts.home ?? homedir()
    this.opts = {
      runDir: opts.runDir,
      socketDir: opts.socketDir ?? opts.runDir,
      approvals: opts.approvals ?? 'bypass',
      bin: opts.bin ?? 'claude',
      args: opts.args ?? [],
      configDir: opts.account?.dir ?? opts.configDir ?? defaultConfigDir(home),
      env: opts.env ?? process.env,
      type: opts.type,
      onWarning: opts.onWarning ?? (() => {}),
      home,
      account: opts.account,
    }
    this.capabilities = claudeCapabilities(opts.account)
  }

  async probe(): Promise<HarnessProbe> {
    const run = promisify(execFile)
    const env = this.accountEnv()
    try {
      const { stdout } = await run(this.opts.bin, ['--version'], { timeout: 10_000, env })
      const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null
      const problems: string[] = []
      const status = await run(this.opts.bin, ['auth', 'status', '--json'], {
        timeout: 10_000,
        env,
      }).catch(() => null)
      if (status) {
        try {
          const said = JSON.parse(status.stdout) as { loggedIn?: unknown }
          if (said.loggedIn !== true) {
            problems.push(
              'Claude Code is not signed in: sign in to it from Settings, or run claude auth login',
            )
          }
        } catch {
          // An answer we cannot read is not a reason to refuse to run.
        }
      }
      return { ok: problems.length === 0, version, problems }
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return {
        ok: false,
        version: null,
        problems: [
          missing
            ? `Claude Code is not installed (no ${this.opts.bin} on the PATH): brew install --cask claude-code`
            : `Claude Code would not say its version: ${(err as Error).message}`,
        ],
      }
    }
  }

  /** Claude Code's tools by what they do. Anything unknown is judged as unknown. */
  effectOf(tool: string): ToolEffect {
    switch (tool) {
      case 'Read':
      case 'Glob':
      case 'Grep':
      case 'LS':
      case 'NotebookRead':
        return 'read'
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return 'write'
      case 'Bash':
        return 'exec'
      default:
        return 'other'
    }
  }

  conversationKey(task: string): string {
    return sessionIdFor(task)
  }

  async hasConversation(task: string, _cwd: string): Promise<boolean> {
    return (await transcriptFor(task, this.opts.configDir)) !== null
  }

  async spent(task: string, _cwd: string): Promise<HarnessSpend> {
    return spentOn(task, this.opts.configDir)
  }

  /**
   * What it can be started on: the names Claude Code keeps pointing at the
   * newest of each line, which it resolves itself. A list of versions kept
   * here would be out of date the first time a model came out.
   */
  async models(): Promise<HarnessModel[]> {
    return ALIASES.map(({ alias, name }) => ({
      id: `anthropic/${alias}`,
      provider: 'anthropic',
      name,
    }))
  }

  /**
   * "opus 5", "the sonnet model", "claude-sonnet-5": a line it keeps an alias
   * for is that alias — Claude Code runs the newest of it — and a full model
   * name is taken as it was said, for Claude Code to accept or refuse.
   */
  async resolveModel(said: string): Promise<ModelFound> {
    const words = said
      .toLowerCase()
      .replace(/^(the\s+)?/, '')
      .replace(/\s+model$/, '')
      .trim()
    if (!words) return { ok: false, reason: 'which model?' }
    const full = /^(anthropic\/)?(claude-[a-z0-9.[\]-]+)$/.exec(words)
    if (full?.[2]) return { ok: true, provider: 'anthropic', id: full[2] }
    const named = ALIASES.filter(({ alias }) => new RegExp(`\\b${alias}\\b`).test(words))
    if (named.length === 1 && named[0]) {
      return { ok: true, provider: 'anthropic', id: named[0].alias }
    }
    return {
      ok: false,
      reason: `Claude Code runs ${ALIASES.map(({ alias }) => alias).join(', ')}, or a model's full name: which is "${said}"?`,
    }
  }

  /** How much of its plan the account has used, as the last agent to report it said. */
  limits(): PlanLimits | null {
    return this.planLimits
  }

  /** Who it is signed in as, as `claude auth status` says: it reads, and asks nothing of anybody. */
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
    try {
      // Signed out, it says so and exits 1: the answer is on standard output either way.
      const stdout = await promisify(execFile)(this.opts.bin, ['auth', 'status', '--json'], {
        timeout: 10_000,
        env: this.accountEnv(),
      }).then(
        (done) => done.stdout,
        (err: NodeJS.ErrnoException & { stdout?: string }) => {
          if (err.code === 'ENOENT' || !err.stdout?.trim()) throw err
          return err.stdout
        },
      )
      const said = JSON.parse(stdout) as Record<string, unknown>
      const text = (key: string) => (typeof said[key] === 'string' ? (said[key] as string) : null)
      const signedIn = said.loggedIn === true
      return {
        signedIn,
        who: text('email') ?? text('orgName'),
        plan: text('subscriptionType'),
        method: text('authMethod'),
        problem: signedIn ? null : 'not signed in yet',
      }
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return {
        ...none,
        problem: missing
          ? 'Claude Code is not installed: brew install --cask claude-code'
          : `Claude Code would not say who it is signed in as: ${(err as Error).message}`,
      }
    }
  }

  /**
   * Its own sign-in, in a terminal you can see: it opens your browser, and
   * whatever it is given goes where Claude Code keeps it — Tade never sees it.
   * An API-key account has nothing to sign in to: its key is kept by Tade.
   */
  signIn(): SignIn | null {
    if (this.opts.account?.kind === 'api-key') return null
    return {
      launch: {
        command: this.opts.bin,
        args: ['auth', 'login', '--claudeai'],
        env: this.ownFolder() ? { CLAUDE_CONFIG_DIR: this.opts.configDir } : {},
      },
      how: 'Claude Code opens your browser to sign in to your Claude account. If it asks, paste the code it shows you here.',
    }
  }

  async signOut(): Promise<void> {
    await promisify(execFile)(this.opts.bin, ['auth', 'logout'], {
      timeout: 30_000,
      env: this.accountEnv(),
    })
  }

  /**
   * A folder of its own, private to you, that Claude Code has already been
   * through its first run in — so the first agent on it starts working rather
   * than choosing a colour scheme — with your own settings, skills and plugins
   * linked in when shared. Its sign-in is its own: that is the point of it.
   */
  async prepareAccount(share: boolean): Promise<void> {
    if (!this.ownFolder()) return
    const dir = this.opts.configDir
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (share) {
      // Yours: the default account's folder, whose settings this one takes.
      const mine = defaultConfigDir(this.opts.home)
      for (const entry of SHARED) {
        const from = join(mine, entry)
        const to = join(dir, entry)
        if (!existsSync(from) || existsSync(to)) continue
        await symlink(from, to)
      }
    }
    const state = join(dir, '.claude.json')
    if (!existsSync(state)) {
      await writeFile(state, `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`, {
        mode: 0o600,
      })
    }
  }

  /**
   * Copy a task's transcript into another account's folder, where that
   * account's Claude Code will find it and carry on: the conversation is a
   * file, and it does not belong to the account that wrote it.
   */
  async carryConversation(task: string, _cwd: string, to: WorkerAdapter): Promise<boolean> {
    if (!(to instanceof ClaudeAdapter) || to.opts.configDir === this.opts.configDir) return false
    const from = await transcriptFor(task, this.opts.configDir)
    if (!from) return false
    const where = relative(this.opts.configDir, from)
    const target = join(to.opts.configDir, where)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(from, target)
    // What the conversation keeps beside it — large tool results, what its
    // subagents said — goes with it.
    const beside = from.replace(/\.jsonl$/, '')
    if (existsSync(beside)) {
      await cp(beside, target.replace(/\.jsonl$/, ''), { recursive: true, force: true })
    }
    return true
  }

  /** Whether this account has a folder of its own, rather than Claude Code's default. */
  private ownFolder(): boolean {
    // Judged against where Claude Code looks when left alone — the real home —
    // whatever `home` this adapter was made with: anywhere else has to be said.
    return this.opts.configDir !== defaultConfigDir(homedir())
  }

  launchSpec(spec: WorkerSpec): LaunchSpec {
    const files = this.filesFor(spec)
    const launch = {
      command: '/bin/sh',
      args: [
        '-c',
        LAUNCHER,
        'tade-claude',
        sessionIdFor(spec.task),
        this.opts.configDir,
        spec.title ?? '',
        this.opts.bin,
        // First: it takes several values, and would take the next word too.
        '--mcp-config',
        ...[files.mcp, ...(spec.extras?.mcp ?? [])],
        '--settings',
        files.settings,
        // Tade's own gate decides what is held; Claude Code asking as well
        // would ask twice, in a lane nobody may be looking at.
        '--permission-mode',
        'bypassPermissions',
        ...(spec.model ? ['--model', modelName(spec.model)] : []),
        ...(spec.thinking ? ['--effort', effortOf(spec.thinking)] : []),
        ...(files.instructions ? ['--append-system-prompt-file', files.instructions] : []),
        ...(files.plugin ? ['--plugin-dir', files.plugin] : []),
        ...this.opts.args,
      ],
    }
    return {
      ...launch,
      env: this.runEnv(spec),
      // Its first message, said at the first launch only.
      ...(spec.prompt ? { opening: [promptWithImages(spec.prompt, spec.images, files.dir)] } : {}),
    }
  }

  async supervise(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    // A folder Claude Code has never run in stops it with a question before
    // anything starts; Tade answers it for the folders it starts agents in.
    await trustFolder(spec.cwd, this.opts.configDir).catch((err) =>
      this.opts.onWarning(
        `could not mark ${spec.cwd} as trusted for Claude Code, so it will ask in its lane: ${(err as Error).message}`,
      ),
    )
    const channel = await ClaudeChannel.listen({
      path: runSocket(this.opts.socketDir, spec.run),
      onRequest: (request) => this.onRequest(spec.run, request),
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
      channel,
      child: null,
      stderr: '',
      cwd: spec.cwd,
      turn: 'starting',
      queued: [],
      naming: null,
      typing: Promise.resolve(),
      held: new Map(),
      calls: new Map(),
      named: Boolean(spec.title),
      titled: false,
      transcript: await transcriptFor(spec.task, this.opts.configDir),
      // A conversation it comes back to arrives with its history, which was
      // reported by whoever was watching then: counted from here, not from zero.
      spent: await spentOn(spec.task, this.opts.configDir),
      cost: 0,
      model: spec.model ? modelName(spec.model) : null,
      context: null,
      counting: null,
    }
    this.runs.set(spec.run, run)
    return { ...run.handle }
  }

  /**
   * Run Claude Code as a child of ours, talking over its own machine protocol
   * rather than drawing a terminal: what the thing you talk to needs, since
   * Tade draws that conversation itself.
   *
   * Nothing is gated here — it is Tade's own interface, and asking permission
   * to answer "where are we" is not a question anybody wants — so no hooks are
   * given to it; what it does arrives as the protocol's own events.
   */
  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    await trustFolder(spec.cwd, this.opts.configDir).catch(() => {})
    const files = this.filesFor(spec, { hooks: false })
    const going = await transcriptFor(spec.task, this.opts.configDir)
    const session = sessionIdFor(spec.task)
    const launch = {
      command: this.opts.bin,
      args: [
        '--mcp-config',
        ...[files.mcp, ...(spec.extras?.mcp ?? [])],
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        // Whole messages and the pieces as they arrive: the window draws a
        // reply as it is written.
        '--verbose',
        '--include-partial-messages',
        // The same conversation every time: made under this id once, and
        // taken up again every time after.
        ...(going ? ['--resume', session] : ['--session-id', session]),
        '--permission-mode',
        'bypassPermissions',
        ...(spec.model ? ['--model', modelName(spec.model)] : []),
        ...(spec.thinking ? ['--effort', effortOf(spec.thinking)] : []),
        ...(files.instructions ? ['--append-system-prompt-file', files.instructions] : []),
        ...(files.plugin ? ['--plugin-dir', files.plugin] : []),
        ...this.opts.args,
      ],
    }
    // It has no lane to carry on in and nobody could find it again, so it
    // does not outlive Tade — however Tade ends.
    const watched = reaped(launch)
    const child = spawn(watched.command, watched.args, {
      cwd: spec.cwd,
      env: { ...this.headlessEnv(spec), ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, like everything Tade starts: a long-lived model
      // process in the terminal's foreground group is what the terminal names
      // its window after.
      detached: true,
    })
    const run: Run = {
      handle: {
        run: spec.run,
        task: spec.task,
        sessionId: session,
        startedAt: Date.now(),
        lane: spec.lane ?? null,
      },
      channel: null,
      child,
      cwd: spec.cwd,
      turn: 'starting',
      queued: [],
      naming: null,
      held: new Map(),
      calls: new Map(),
      named: Boolean(spec.title),
      titled: false,
      transcript: going,
      spent: await spentOn(spec.task, this.opts.configDir),
      cost: 0,
      model: spec.model ? modelName(spec.model) : null,
      context: null,
      counting: null,
      typing: Promise.resolve(),
      stderr: '',
    }
    this.runs.set(spec.run, run)
    let rest = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        const line = rest.slice(0, end).trim()
        rest = rest.slice(end + 1)
        if (line) this.onProtocol(run, line)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      run.stderr = (run.stderr + chunk.toString('utf8')).slice(-4_000)
    })
    child.on('exit', (code) => {
      // A process that ends before it says anything says why from what it
      // wrote, rather than leaving a caller waiting on a turn that never comes.
      if (code !== 0 && code !== null) {
        this.say(run, { type: 'failed', error: exitReason(code, run.stderr ?? '') })
      }
      this.say(run, { type: 'exited', code })
      this.runs.delete(spec.run)
    })
    if (spec.prompt.trim()) await this.prompt(spec.run, spec.prompt, spec.images ?? [])
    return { ...run.handle }
  }

  /** What the protocol says, line by line, as Tade's own signals. */
  private onProtocol(run: Run, line: string): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not ours to read: anything Claude Code prints that is not the protocol.
      return
    }
    const message = event.message as { content?: unknown; model?: unknown } | undefined
    switch (event.type) {
      case 'system': {
        if (event.subtype !== 'init') return
        if (typeof event.model === 'string') run.model = event.model
        // Said once: a turn of its own begins with an init line every time.
        if (run.turn === 'starting') {
          this.say(run, {
            type: 'started',
            sessionId: typeof event.session_id === 'string' ? event.session_id : null,
            model: run.model,
            thinking: null,
          })
        }
        run.turn = 'running'
        this.say(run, { type: 'turn_started' })
        return
      }
      case 'stream_event': {
        const delta = (event.event as { delta?: { type?: unknown; text?: unknown } } | undefined)
          ?.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.say(run, { type: 'message_delta', text: delta.text })
        }
        return
      }
      case 'assistant': {
        if (typeof message?.model === 'string') run.model = message.model
        for (const block of Array.isArray(message?.content) ? message.content : []) {
          const part = block as Record<string, unknown>
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            this.say(run, { type: 'message', text: part.text })
          } else if (part.type === 'tool_use') {
            this.say(run, {
              type: 'tool_call',
              callId: String(part.id ?? ''),
              tool: toolName(String(part.name ?? '')),
              input: part.input ?? {},
            })
          }
        }
        return
      }
      case 'user': {
        for (const block of Array.isArray(message?.content) ? message.content : []) {
          const part = block as Record<string, unknown>
          if (part.type !== 'tool_result') continue
          this.say(run, {
            type: 'tool_result',
            callId: String(part.tool_use_id ?? ''),
            ok: part.is_error !== true,
            summary: part.is_error === true ? String(part.content ?? '').slice(0, 300) : '',
          })
        }
        return
      }
      case 'result': {
        this.sayResultUsage(run, event)
        const aborted = run.aborting === true
        run.aborting = false
        const failed = event.is_error === true || event.subtype !== 'success'
        this.say(run, {
          type: 'turn_done',
          status: aborted ? 'aborted' : failed ? 'error' : 'ok',
          ...(failed && !aborted
            ? { reason: String(event.result ?? event.subtype ?? 'the model returned an error') }
            : {}),
        })
        run.turn = 'idle'
        this.say(run, { type: 'idle' })
        return
      }
      default:
        return
    }
  }

  /**
   * Money, or nothing at all.
   *
   * Claude Code's figure is its own estimate of what an API would have
   * charged, and on a plan that is not what anybody pays: reported as money it
   * makes a total that means nothing out of a flat fee. So it is reported only
   * where this account is billed per token, which is what the harness already
   * declares (`capabilities.spend.usd`) and what every reader of the journal
   * reads it as.
   */
  private priceable(usd: number): number {
    return this.capabilities.spend.usd === 'none' ? 0 : usd
  }

  /** What a turn cost, as the protocol reports it when the turn ends. */
  private sayResultUsage(run: Run, event: Record<string, unknown>): void {
    const usage = (event.usage ?? {}) as Record<string, unknown>
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
    const input = count('input_tokens')
    const output = count('output_tokens')
    const cacheRead = count('cache_read_input_tokens')
    const cacheWrite = count('cache_creation_input_tokens')
    const total = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0
    // Its own running total for this process where it grows, and what this
    // turn cost where it does not: never a charge made up out of the two.
    const usd = this.priceable(total > run.cost ? total - run.cost : total)
    if (total > run.cost) run.cost = total
    const tokens = input + output + cacheRead + cacheWrite
    if (tokens <= 0 && usd <= 0) return
    this.say(run, {
      type: 'usage',
      model: run.model,
      input,
      output,
      cacheRead,
      cacheWrite,
      tokens,
      usd,
    })
  }

  /** What a headless run is told about itself. */
  private headlessEnv(spec: WorkerSpec): NodeJS.ProcessEnv {
    const env = this.accountEnv()
    env[WORKER_ENV.run] = spec.run
    env[WORKER_ENV.task] = spec.task
    env.MCP_TOOL_TIMEOUT = String(15 * 60_000)
    if (spec.extras?.tools) env[WORKER_ENV.tools] = spec.extras.tools
    return env
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

  /** What it is thinking with, as it said when this turn began. */
  async modelOf(run: RunId): Promise<WorkerModel | null> {
    const entry = this.require(run)
    return entry.model ? { provider: 'anthropic', id: entry.model } : null
  }

  async setModel(_run: RunId, _model: WorkerModel): Promise<void> {
    // Never typed as `/model`: Claude Code saves that as the default for every
    // new session, which is one agent's model leaking into everyone's.
    throw new Error(`Claude Code ${this.capabilities.why.model}`)
  }

  async setThinking(_run: RunId, _level: ThinkingLevel): Promise<void> {
    throw new Error(`Claude Code ${this.capabilities.why.thinking}`)
  }

  async name(run: RunId, title: string): Promise<void> {
    const entry = this.require(run)
    const flat = title.replace(/\s+/g, ' ').trim()
    if (!flat) return
    entry.named = true
    if (entry.turn === 'idle') await this.type(entry, `/rename ${flat}`)
    else entry.naming = flat
  }

  async abort(run: RunId): Promise<void> {
    const entry = this.require(run)
    if (entry.turn !== 'running') return
    if (entry.child) {
      // The protocol's own way to stop a turn: it answers, keeps what was
      // said so far, and ends the turn as one that was stopped.
      entry.aborting = true
      entry.child.stdin?.write(
        `${JSON.stringify({ type: 'control_request', request_id: `abort-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`,
      )
      return
    }
    // Escape, as a key and not as text. Claude Code runs no hook when a turn
    // is cut short, so the end of it is said here.
    await this.inTurn(entry, () => this.keys(entry, '\x1b'))
    this.settle(entry, 'aborted')
  }

  async stop(run: RunId): Promise<void> {
    const entry = this.require(run)
    // A headless run is ours to end: its group, since it runs in its own.
    const pid = entry.child?.pid
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        entry.child?.kill('SIGTERM')
      }
    }
    // A lane is closed by whoever opened it; this lets go of the channel.
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

  /** Let go of every agent without ending it: they carry on in their lanes. */
  async detach(): Promise<void> {
    for (const run of [...this.runs.values()]) await this.forget(run)
  }

  async shutdown(): Promise<void> {
    await this.detach()
  }

  // --- what the agent says ------------------------------------------------------

  private async onRequest(run: RunId, request: ChannelRequest): Promise<unknown> {
    const entry = this.runs.get(run)
    if (!entry) return {}
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
    }
  }

  private async onHook(entry: Run, event: Record<string, unknown>): Promise<unknown> {
    const str = (key: string) => (typeof event[key] === 'string' ? (event[key] as string) : null)
    switch (event.hook_event_name) {
      case 'SessionStart': {
        entry.turn = 'idle'
        entry.transcript = str('transcript_path') ?? entry.transcript
        // A new process: its running cost starts again from nothing.
        entry.cost = 0
        entry.model = str('model') ?? entry.model
        this.say(entry, {
          type: 'started',
          sessionId: str('session_id'),
          model: entry.model,
          thinking: null,
        })
        // Anything said before it could listen, said now it can.
        setTimeout(() => void this.flush(entry), 500).unref?.()
        return null
      }
      case 'UserPromptSubmit': {
        entry.turn = 'running'
        this.say(entry, { type: 'turn_started' })
        const prompt = str('prompt') ?? ''
        // A turn it started itself, when something it left running finished,
        // is not anybody's words to name the work after.
        if (!entry.named && !entry.titled && !prompt.startsWith('<task-notification>')) {
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
        const tool = toolName(str('tool_name') ?? '')
        const input = event.tool_input ?? {}
        this.say(entry, { type: 'tool_call', callId, tool, input })
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
      case 'Stop': {
        const said = str('last_assistant_message')
        if (said) this.say(entry, { type: 'message', text: said })
        await this.sayUsage(entry)
        this.settle(entry, 'ok')
        return null
      }
      case 'StopFailure': {
        const error = str('error')
        const said = str('last_assistant_message')
        this.settle(entry, 'error', [error, said].filter(Boolean).join(': ') || undefined)
        return null
      }
      case 'Notification': {
        // Claude Code runs no hook when a person cuts a turn short in its
        // lane; the next thing it says is that it is waiting for input.
        if (event.notification_type === 'idle_prompt' && entry.turn === 'running') {
          const tail = entry.transcript
            ? await readFile(entry.transcript, 'utf8').then(
                (text) => text.slice(-20_000),
                () => '',
              )
            : ''
          this.settle(entry, interruptedIn(tail) ? 'aborted' : 'ok')
        }
        return null
      }
      default:
        return null
    }
  }

  private onStatus(entry: Run, status: Record<string, unknown>): void {
    // Its status line is drawn after each reply, which is after the reply has
    // been written to the transcript — later than its Stop hook, which runs
    // before the last of it is. So the turn's tokens are counted from here,
    // a moment after the status line stops changing.
    if (entry.counting) clearTimeout(entry.counting)
    entry.counting = setTimeout(() => {
      entry.counting = null
      void this.sayUsage(entry)
    }, COUNT_AFTER_MS)
    entry.counting.unref?.()
    const model = (status.model as { id?: unknown } | undefined)?.id
    if (typeof model === 'string') entry.model = model
    const window = status.context_window as
      | {
          used_percentage?: unknown
          current_usage?: Record<string, unknown> | null
        }
      | undefined
    const percent = typeof window?.used_percentage === 'number' ? window.used_percentage : null
    if (percent !== null && percent !== entry.context) {
      entry.context = percent
      const usage = window?.current_usage ?? {}
      const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
        .map((key) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0))
        .reduce((a, b) => a + b, 0)
      this.say(entry, { type: 'context', tokens: tokens || null, percent })
    }
    // Its own estimate of what the session has cost, as a running total for
    // this process: what grew since it last said is what this reply cost —
    // and nothing at all where a plan pays, because a usage signal of zeros is
    // a line in the journal that says nothing. The tokens still arrive, from
    // the transcript, as the turn ends.
    const cost = (status.cost as { total_cost_usd?: unknown } | undefined)?.total_cost_usd
    if (typeof cost === 'number' && cost > entry.cost) {
      const usd = this.priceable(cost - entry.cost)
      entry.cost = cost
      if (usd > 0) {
        this.say(entry, {
          type: 'usage',
          model: entry.model,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tokens: 0,
          usd,
        })
      }
    }
    const limits = status.rate_limits as Record<string, unknown> | undefined
    if (limits) {
      const window = (key: string) => {
        const one = limits[key] as { used_percentage?: unknown; resets_at?: unknown } | undefined
        return typeof one?.used_percentage === 'number'
          ? { used: one.used_percentage, resetsAt: Number(one.resets_at ?? 0) * 1000 }
          : null
      }
      this.planLimits = {
        at: Date.now(),
        fiveHour: window('five_hour'),
        sevenDay: window('seven_day'),
      }
    }
  }

  /** What the turn spent, in tokens, from the transcript: the ledger, read as the turn ends. */
  private async sayUsage(entry: Run): Promise<void> {
    if (!entry.transcript) return
    const now = spentIn(await readFile(entry.transcript, 'utf8').catch(() => ''))
    const was = entry.spent
    const tokens = now.tokens - was.tokens
    if (tokens <= 0) return
    entry.spent = now
    this.say(entry, {
      type: 'usage',
      model: now.model,
      input: now.input - was.input,
      output: now.output - was.output,
      cacheRead: now.cacheRead - was.cacheRead,
      cacheWrite: now.cacheWrite - was.cacheWrite,
      tokens,
      // Priced by what it says while it runs (`onStatus`), never here.
      usd: 0,
    })
  }

  /** A turn is over: say how, then say whatever was waiting for it to be. */
  private settle(entry: Run, status: 'ok' | 'error' | 'aborted', reason?: string): void {
    entry.turn = 'idle'
    this.say(entry, { type: 'turn_done', status, ...(reason ? { reason } : {}) })
    this.say(entry, { type: 'idle' })
    // After Claude Code has drawn its prompt again: typed into a turn that is
    // still closing, it would be taken as a steer into it.
    setTimeout(() => void this.flush(entry), 300).unref?.()
  }

  // --- what we say to it ----------------------------------------------------------

  private async steerOn(entry: Run, message: string): Promise<void> {
    // Headless, it reads what it is told: a message sent mid-turn is taken up
    // as the next turn, which is what "after this one" means anyway.
    if (entry.child) return this.send(entry, message)
    // In a lane, before the session has begun, there is nothing to type into.
    if (entry.turn === 'starting') entry.queued.push(message)
    else await this.type(entry, message)
  }

  private async queueOn(entry: Run, message: string): Promise<void> {
    if (entry.child) return this.send(entry, message)
    if (entry.turn === 'idle') await this.type(entry, message)
    else entry.queued.push(message)
  }

  /** Say something to a headless run, in the protocol's own words. */
  private async send(entry: Run, message: string): Promise<void> {
    const said = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    }
    const wrote = entry.child?.stdin?.write(`${JSON.stringify(said)}\n`)
    if (wrote === undefined) throw new WorkerNotFoundError(entry.handle.run)
  }

  private async flush(entry: Run): Promise<void> {
    if (entry.turn !== 'idle' || !this.runs.has(entry.handle.run)) return
    // Taken at once, before anything waits: a second flush finds nothing left.
    const naming = entry.naming
    entry.naming = null
    const said = entry.queued.splice(0).join('\n\n')
    if (naming) await this.type(entry, `/rename ${naming}`).catch(() => {})
    if (!said) return
    await this.type(entry, said).catch((err: unknown) =>
      this.say(entry, {
        type: 'problem',
        text: `could not say a queued message to Claude Code: ${(err as Error).message}`,
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
      await new Promise((resolve) => setTimeout(resolve, 40))
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
    if (!this.opts.type) throw new Error('there is no terminal to type into for Claude Code')
    await this.opts.type(entry.handle.run, bytes)
  }

  // --- bookkeeping ----------------------------------------------------------------

  private say(entry: Run, signal: DistributiveOmit<WorkerSignal, 'run' | 'at'>): void {
    const full = { ...signal, run: entry.handle.run, at: Date.now() } as WorkerSignal
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
    if (entry.counting) clearTimeout(entry.counting)
    // Nothing left to answer them: a held call is refused rather than left
    // hanging, and Claude Code's hook says so under `policy`.
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

  private accountEnv(): NodeJS.ProcessEnv {
    const env = { ...this.opts.env }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    for (const name of INHERITED_SESSION) delete env[name]
    if (this.ownFolder()) {
      env.CLAUDE_CONFIG_DIR = this.opts.configDir
    }
    return env
  }

  private runEnv(spec: WorkerSpec): Record<string, string> {
    const env: Record<string, string> = {
      [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
      [WORKER_ENV.approvals]: this.opts.approvals,
      [WORKER_ENV.run]: spec.run,
      [WORKER_ENV.task]: spec.task,
      // A tool Tade runs may take minutes: longer than Claude Code waits on an MCP call by default.
      MCP_TOOL_TIMEOUT: String(15 * 60_000),
    }
    if (spec.extras?.tools) env[WORKER_ENV.tools] = spec.extras.tools
    if (spec.title) env[WORKER_ENV.title] = spec.title
    // Its own folder, unless it is the default: Claude Code names its keychain
    // entry after the folder it was told, so saying the default out loud
    // would sign it out.
    if (this.ownFolder()) {
      env.CLAUDE_CONFIG_DIR = this.opts.configDir
    }
    const theirs = this.ownStatusLine()
    if (theirs) env.TADE_CLAUDE_STATUSLINE = theirs
    return env
  }

  /** The status line its owner set up, which Tade's runs in front of rather than replaces. */
  private ownStatusLine(): string | null {
    try {
      const settings = JSON.parse(
        readFileSync(join(this.opts.configDir, 'settings.json'), 'utf8'),
      ) as { statusLine?: { command?: unknown } }
      const command = settings.statusLine?.command
      return typeof command === 'string' && command.trim() ? command : null
    } catch {
      return null
    }
  }

  private filesDir(run: string): string {
    return join(
      this.opts.runDir,
      'claude',
      createHash('sha1').update(run).digest('hex').slice(0, 12),
    )
  }

  /**
   * What this run is handed, written where the line that launches it can find
   * it again: the hooks and status line, the server that lends it Tade's
   * tools, the instructions appended to its own, and the skills extensions
   * ship. Written the same every time, so the line stays the same.
   */
  private filesFor(
    spec: WorkerSpec,
    opts: { hooks?: boolean } = {},
  ): {
    dir: string
    settings: string
    mcp: string
    instructions: string | null
    plugin: string | null
  } {
    const dir = this.filesDir(spec.run)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const node = shellWord(process.execPath)
    const hook = (timeout: number) => [
      { hooks: [{ type: 'command', command: `${node} ${shellWord(HOOK_PATH)}`, timeout }] },
    ]
    const settings = join(dir, 'settings.json')
    write(settings, {
      // A headless run is Tade's own interface: nothing of it is gated, so it
      // is given no hooks at all and says what it does over the protocol.
      hooks:
        opts.hooks === false
          ? {}
          : {
              SessionStart: hook(30),
              UserPromptSubmit: hook(30),
              // Held for as long as a person takes to answer, under `policy`.
              PreToolUse: hook(24 * 60 * 60),
              PostToolUse: hook(30),
              PostToolUseFailure: hook(30),
              Stop: hook(30),
              StopFailure: hook(30),
              Notification: hook(30),
            },
      statusLine: { type: 'command', command: `${node} ${shellWord(STATUSLINE_PATH)}` },
      // Bypass mode asks once whether you accept it; Tade's gate is what holds a call.
      skipDangerousModePermissionPrompt: true,
      // An API-key account: its key read when Claude Code needs it, from where
      // Tade keeps it, and never written here.
      ...(this.opts.account?.kind === 'api-key' && this.opts.account.key
        ? { apiKeyHelper: this.opts.account.key }
        : {}),
    })
    const mcp = join(dir, 'mcp.json')
    write(mcp, {
      mcpServers: {
        tade: {
          type: 'stdio',
          command: process.execPath,
          args: [MCP_PATH],
          env: {
            [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
            [WORKER_ENV.run]: spec.run,
            [WORKER_ENV.task]: spec.task,
            ...(spec.extras?.tools ? { [WORKER_ENV.tools]: spec.extras.tools } : {}),
          },
        },
      },
    })
    let instructions: string | null = null
    if (spec.extras?.instructions) {
      instructions = join(dir, 'instructions.md')
      writeFileSync(instructions, spec.extras.instructions, { mode: 0o600 })
    }
    let plugin: string | null = null
    const skills = spec.extras?.skills ?? []
    if (skills.length > 0) {
      plugin = join(dir, 'plugin')
      rmSync(plugin, { recursive: true, force: true })
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
      mkdirSync(join(plugin, 'skills'), { recursive: true })
      write(join(plugin, '.claude-plugin', 'plugin.json'), {
        name: 'tade',
        version: '1.0.0',
        description: "What Tade's extensions give this agent",
      })
      for (const skill of skills) symlinkSync(skill, join(plugin, 'skills', basename(skill)))
    }
    return { dir, settings, mcp, instructions, plugin }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** A word the shell reads back as itself. */
function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Where a run's supervision socket lives: hashed, because a long path fails to bind. */
export function runSocket(dir: string, run: string): string {
  return join(dir, `c-${createHash('sha1').update(run).digest('hex').slice(0, 12)}.sock`)
}

/** A model as Claude Code takes it: an alias or a full name, never a provider's prefix. */
export function modelName(model: WorkerModel): string {
  return model.id.includes('/') ? (model.id.split('/').at(-1) ?? model.id) : model.id
}

/** A thinking level as Claude Code's `--effort`: it has no "off", so the least it has. */
export function effortOf(level: ThinkingLevel): string {
  return EFFORTS.includes(level) ? level : 'low'
}

/** Tade's own tools by their own names; everything else as Claude Code calls it. */
export function toolName(name: string): string {
  return name.startsWith(OURS) ? name.slice(OURS.length) : name
}

/**
 * Pictures, as files it is told about: its terminal cannot be handed one, and
 * it reads a picture it is pointed at.
 */
function promptWithImages(
  message: string,
  images: readonly WorkerImage[] | undefined,
  dir: string,
): string {
  if (!images || images.length === 0) return message
  const folder = join(dir, 'attachments')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const paths = images.map((image, n) => {
    const extension = image.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const path = join(folder, `${Date.now()}-${n + 1}.${extension}`)
    writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return path
  })
  return `${message}\n\n${paths.map((path) => `[picture: ${path}]`).join('\n')}`
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
    case 'Bash':
      return `Bash: ${first('command')}`
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Read':
      return `${tool} ${first('file_path', 'notebook_path')}`
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
