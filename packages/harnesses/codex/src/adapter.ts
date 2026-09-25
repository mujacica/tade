import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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
import { type ChannelRequest, CodexChannel } from './channel.ts'
import {
  contextIn,
  conversationKey,
  defaultHome,
  limitsIn,
  rememberThread,
  rolloutFor,
  spentIn,
  spentOn,
  threadFile,
  threadOf,
  whoIn,
} from './sessions.ts'
import { toml } from './toml.ts'

// Drives Codex as a Tade worker: the official `codex`, unmodified, in a lane
// you can watch, signed in however its owner signed it in.
//
// Nothing of ours runs inside it the way the supervision extension runs inside
// pi. What it tells us arrives through its lifecycle hooks and, headless,
// through the events its non-interactive run prints — all handed to it for
// this run alone, as config overrides on the command line, so nothing in
// anybody's own `~/.codex` is touched. What we tell it is typed into its
// terminal, as a person would.

export const HOOK_PATH = fileURLToPath(new URL('./hook.ts', import.meta.url))
export const MCP_PATH = fileURLToPath(new URL('./mcp.ts', import.meta.url))

/** The harness's name, as tasks, routes and the journal say it. */
export const CODEX = 'codex'

/** How hard Codex can be told to think, least to most: its `model_reasoning_effort`. */
const EFFORTS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** What of your own Codex a second account is given, when shared: never its sign-in. */
const SHARED = ['config.toml', 'AGENTS.md', 'skills', 'plugins', 'rules', 'prompts']

/** Tade's own tools, as Codex names a tool an MCP server brought. */
const OURS = 'mcp__tade__'

/** How long a hook Codex runs as it is ending may take: its own cap, in seconds. */
const LATE_S = 3

/**
 * An API key inherited from somebody's shell. Codex would pay with it rather
 * than with the account the agent was given, so it is dropped — except for an
 * account that is an API key, whose own key the launcher reads at the moment
 * it starts.
 */
const INHERITED_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY']

/**
 * How an agent is started or brought back: one line either way.
 *
 * Codex makes the thread id itself and takes none from us, so the line looks
 * for the one Tade wrote down when this task's agent last said hello, and
 * resumes it when there is one. That keeps the line Tade writes down the one
 * that reattaches, wherever it is run from — and it carries no key: an
 * API-key account's key is read here, by the command that prints it, and
 * never written into an argument or an environment Tade stores.
 */
const LAUNCHER = [
  'look="$1"; key="$2"; bin="$3"; shift 3',
  `unset ${INHERITED_KEYS.join(' ')}`,
  'if [ -n "$key" ]; then',
  '  CODEX_API_KEY=$(sh -c "$key") || exit 1',
  '  OPENAI_API_KEY="$CODEX_API_KEY"',
  '  export CODEX_API_KEY OPENAI_API_KEY',
  'fi',
  'thread=""',
  'if [ -r "$look" ]; then thread=$(cat "$look"); fi',
  'if [ -n "$thread" ]; then exec "$bin" resume "$thread" "$@"; fi',
  'exec "$bin" "$@"',
].join('\n')

export interface CodexAdapterOptions {
  /** Directory for per-run files, and where the thread each task talks in is written down. */
  runDir: string
  /** Where supervision sockets go; a short path, because a long one fails to bind. */
  socketDir?: string
  approvals?: 'bypass' | 'policy'
  /** The `codex` to run. Found on the PATH by default. */
  bin?: string
  /**
   * The account: the folder Codex keeps its sign-in, config and threads in.
   * Its own default, `~/.codex`, unless another was chosen.
   */
  codexHome?: string
  env?: NodeJS.ProcessEnv
  /** Extra arguments appended to every launch, for tests that need it told something. */
  args?: string[]
  /** Type into an agent's terminal: how anything is said to it, since it listens nowhere else. */
  type?: (run: RunId, text: string) => Promise<void>
  onWarning?: (message: string) => void
  /**
   * The account it runs as, when not the default: its folder becomes the
   * Codex home, and an API-key account is paid for by the key its command
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
  /** What it was started with: what every launch and every turn is built from. */
  spec: WorkerSpec
  /** The socket its hooks report over. */
  channel: CodexChannel | null
  /**
   * Whether Tade draws this conversation itself, in which case a turn is a
   * process of ours rather than something happening in a lane.
   */
  headless: boolean
  /** The process running the turn, for a headless run: the one Tade draws itself. */
  child?: ChildProcess | null
  /** The last it wrote to standard error, which is where it says why it would not start. */
  stderr?: string
  /** Tade asked for the turn to stop, so the end of it is not a failure. */
  aborting?: boolean
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
  /** What Tade's extensions give this agent, said at every session start. */
  told: string
  /** The thread Codex is keeping this conversation in, once it has said. */
  thread: string | null
  /** What the rollout had spent when we last said, so each turn sends only the difference. */
  spent: HarnessSpend
  model: string | null
  /** How full the context was when we last said, so it is said only when it moves. */
  fullness: number | null
  /** Where the files this run was handed live. */
  dir: string
  /**
   * What a turn has printed, taken one line at a time. The events are an
   * order — the thread is named before anything is said in it — and answering
   * two at once loses that order.
   */
  events: Promise<void>
}

export class CodexAdapter implements WorkerAdapter {
  readonly id = CODEX
  /** OpenAI, through its own sign-in: Codex reaches nothing else. */
  readonly provider = 'openai'
  readonly capabilities: WorkerCapabilities = {
    // Its PreToolUse hook holds the call until Tade answers, and a refusal
    // from that hook is what stops it.
    permissionGate: true,
    // Typed while a turn runs, Codex takes it into the turn it is running.
    steer: 'live',
    // Typed at any time: Codex answers it when the turn it is in ends.
    queue: 'live',
    abort: 'live',
    model: 'restart',
    thinking: 'restart',
    thinkingLevels: EFFORTS,
    rename: 'idle',
    visibleUi: true,
    resume: true,
    // A resumed thread starts on the account's own default, so the model and
    // the effort are said again at every launch.
    resumeKeeps: false,
    images: 'path',
    done: true,
    nativeExtensions: false,
    // Named to it at every session start, with where to read each — which is
    // how Codex's own skills reach it too, since it finds those in folders
    // Tade has no business writing into.
    skills: true,
    tools: true,
    mcp: true,
    // `codex exec --json`: a turn run to completion under Codex's own event
    // stream, which is how Tade draws the thing you talk to.
    headless: true,
    spend: { usd: 'none', tokens: true, limits: 'while-working' },
    accounts: true,
    why: {
      model:
        'takes a model only when it starts, so changing it starts the agent again, keeping the conversation',
      models:
        'names its own models (codex debug models), and the codex on this machine did not answer',
      thinking:
        'takes how hard to think only when it starts, so changing it starts the agent again, keeping the conversation',
      rename: 'renames a thread only between turns, so a new name waits for the turn to end',
      images: 'is shown a picture as a file it is told about, since its terminal cannot take one',
      nativeExtensions:
        'has no place for pi extensions: their tools and skills still reach it, their own code does not',
      spend:
        'counts tokens but never prices them, so what a Codex agent cost in money is not a number anybody here can honestly give',
      limits: 'says it as each turn ends, so nothing shows until an agent has worked',
    },
  }

  readonly programs: readonly RequiredProgram[] = [
    {
      command: 'codex',
      title: 'Codex',
      why: 'being the agent, for every task set to run in it',
      versionArgs: ['--version'],
      install: { npm: '@openai/codex' },
    },
  ]

  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly opts: Required<Omit<CodexAdapterOptions, 'type' | 'account'>> & {
    type: CodexAdapterOptions['type']
    account: HarnessAccount | undefined
  }
  private planLimits: PlanLimits | null = null

  constructor(opts: CodexAdapterOptions) {
    const home = opts.home ?? homedir()
    this.opts = {
      runDir: opts.runDir,
      socketDir: opts.socketDir ?? opts.runDir,
      approvals: opts.approvals ?? 'bypass',
      bin: opts.bin ?? 'codex',
      args: opts.args ?? [],
      codexHome: opts.account?.dir ?? opts.codexHome ?? defaultHome(home),
      env: opts.env ?? process.env,
      type: opts.type,
      onWarning: opts.onWarning ?? (() => {}),
      home,
      account: opts.account,
    }
  }

  async probe(): Promise<HarnessProbe> {
    const run = promisify(execFile)
    try {
      const { stdout } = await run(this.opts.bin, ['--version'], {
        timeout: 10_000,
        env: this.accountEnv(),
      })
      const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null
      const who = await this.account()
      return {
        ok: who.signedIn,
        version,
        problems: who.signedIn
          ? []
          : [
              who.problem ??
                'Codex is not signed in: sign in to it from Settings, or run codex login',
            ],
      }
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return {
        ok: false,
        version: null,
        problems: [
          missing
            ? `Codex is not installed (no ${this.opts.bin} on the PATH): brew install --cask codex`
            : `Codex would not say its version: ${(err as Error).message}`,
        ],
      }
    }
  }

  /**
   * Codex's tools by what they do, under both the names it uses in a hook —
   * which are Claude Code's, because its hooks speak that language — and the
   * ones it writes into its own rollout. Anything unknown is judged as unknown.
   */
  effectOf(tool: string): ToolEffect {
    switch (tool) {
      case 'Read':
      case 'read_file':
      case 'Glob':
      case 'Grep':
      case 'LS':
      case 'list_dir':
      case 'view_image':
        return 'read'
      case 'Write':
      case 'Edit':
      case 'apply_patch':
      case 'write_file':
        return 'write'
      case 'Bash':
      case 'shell':
      case 'unified_exec':
      case 'write_stdin':
        return 'exec'
      default:
        return 'other'
    }
  }

  conversationKey(task: string): string {
    return conversationKey(task)
  }

  /**
   * Whether this task's agent has a thread to come back to: one Tade wrote
   * down, and that Codex still has the record of. A note pointing at a thread
   * Codex has forgotten is not a conversation.
   */
  async hasConversation(task: string, _cwd: string): Promise<boolean> {
    const thread = await threadOf(task, this.opts.runDir)
    if (!thread) return false
    return (await rolloutFor(thread, this.opts.codexHome)) !== null
  }

  async spent(task: string, _cwd: string): Promise<HarnessSpend> {
    return spentOn(task, this.opts.runDir, this.opts.codexHome)
  }

  /**
   * What it can be started on, as Codex's own catalog names them. Asked of
   * Codex rather than kept here, because a list of models written down would
   * be out of date the first time one came out.
   */
  async models(): Promise<HarnessModel[]> {
    const said = await promisify(execFile)(this.opts.bin, ['debug', 'models'], {
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
      env: this.accountEnv(),
    }).then(
      (done) => done.stdout,
      () => '',
    )
    return catalogIn(said)
  }

  /**
   * "gpt-5.3-codex", "the codex model": a name among what Codex offers, or a
   * full model name taken as it was said, for Codex to accept or refuse.
   */
  async resolveModel(said: string): Promise<ModelFound> {
    const words = said
      .toLowerCase()
      .replace(/^(the\s+)?/, '')
      .replace(/\s+model$/, '')
      .replace(/^openai\//, '')
      .trim()
    if (!words) return { ok: false, reason: 'which model?' }
    const offered = await this.models()
    const slugs = offered.map((model) => model.id.split('/').slice(1).join('/'))
    const exact = slugs.find((slug) => slug.toLowerCase() === words)
    if (exact) return { ok: true, provider: 'openai', id: exact }
    const near = slugs.filter((slug) => slug.toLowerCase().includes(words))
    if (near.length === 1 && near[0]) return { ok: true, provider: 'openai', id: near[0] }
    // A name that reads like a model's own is taken as it was said — the
    // catalog is what Codex shows people, not everything it will run, and
    // there may be no Codex here to ask at all. Codex says whether it knows
    // it; what is refused here is a name no model was ever called.
    if (/^[a-z0-9][a-z0-9.-]*\d[a-z0-9.-]*$/.test(words)) {
      return { ok: true, provider: 'openai', id: words }
    }
    return {
      ok: false,
      reason:
        slugs.length > 0
          ? `Codex runs ${slugs.slice(0, 6).join(', ')}: which is "${said}"?`
          : `Codex did not say which models it runs, so "${said}" cannot be placed`,
    }
  }

  /** How much of its plan the account has used, as the last agent to report it said. */
  limits(): PlanLimits | null {
    return this.planLimits
  }

  /**
   * Who it is signed in as. How, from `codex login status`, which reads and
   * asks nothing of anybody; who and on what plan, from the claims in the
   * sign-in Codex keeps, because its answer says only how.
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
    try {
      // Signed out, it says so and exits non-zero: the answer is on standard
      // output either way.
      const stdout = await promisify(execFile)(this.opts.bin, ['login', 'status'], {
        timeout: 10_000,
        env: this.accountEnv(),
      }).then(
        (done) => done.stdout,
        (err: NodeJS.ErrnoException & { stdout?: string }) => {
          if (err.code === 'ENOENT' || !err.stdout?.trim()) throw err
          return err.stdout
        },
      )
      const method = methodIn(stdout)
      if (!method) return { ...none, problem: 'not signed in yet' }
      const { who, plan } = await whoIn(this.opts.codexHome)
      return { signedIn: true, who, plan, method, problem: null }
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return {
        ...none,
        problem: missing
          ? 'Codex is not installed: brew install --cask codex'
          : `Codex would not say who it is signed in as: ${(err as Error).message}`,
      }
    }
  }

  /**
   * Its own sign-in, in a terminal you can see: it opens your browser, and
   * whatever it is given goes where Codex keeps it — Tade never sees it. An
   * API-key account has nothing to sign in to: its key is kept by Tade.
   */
  signIn(): SignIn | null {
    if (this.opts.account?.kind === 'api-key') return null
    return {
      launch: {
        command: this.opts.bin,
        args: ['login'],
        env: this.ownFolder() ? { CODEX_HOME: this.opts.codexHome } : {},
      },
      how: 'Codex opens your browser to sign in to your ChatGPT account. If it asks, confirm the code it shows you here.',
    }
  }

  async signOut(): Promise<void> {
    await promisify(execFile)(this.opts.bin, ['logout'], {
      timeout: 30_000,
      env: this.accountEnv(),
    })
  }

  /**
   * A folder of its own, private to you, with your own config, skills and
   * plugins linked in when shared. Its sign-in is its own: that is the point
   * of it, so nothing of the sign-in is copied and the first thing an account
   * needs is to be signed in.
   */
  async prepareAccount(share: boolean): Promise<void> {
    if (!this.ownFolder()) return
    const dir = this.opts.codexHome
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (!share) return
    // Yours: the default account's folder, whose settings this one takes.
    const mine = defaultHome(this.opts.home)
    for (const entry of SHARED) {
      const from = join(mine, entry)
      const to = join(dir, entry)
      if (!existsSync(from) || existsSync(to)) continue
      await symlink(from, to).catch(() => {})
    }
  }

  /**
   * Copy a task's thread into another account's folder, where that account's
   * Codex will find it and carry on, and write down the same thread for it:
   * the conversation is a file, and it does not belong to the account that
   * wrote it.
   */
  async carryConversation(task: string, _cwd: string, to: WorkerAdapter): Promise<boolean> {
    if (!(to instanceof CodexAdapter) || to.opts.codexHome === this.opts.codexHome) return false
    const thread = await threadOf(task, this.opts.runDir)
    if (!thread) return false
    const from = await rolloutFor(thread, this.opts.codexHome)
    if (!from) return false
    const target = join(to.opts.codexHome, relative(this.opts.codexHome, from))
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(from, target)
    await rememberThread(task, to.opts.runDir, thread)
    return true
  }

  /** Whether this account has a folder of its own, rather than Codex's default. */
  private ownFolder(): boolean {
    // Judged against where Codex looks when left alone — the real home —
    // whatever `home` this adapter was made with: anywhere else has to be said.
    return this.opts.codexHome !== defaultHome(homedir())
  }

  launchSpec(spec: WorkerSpec): LaunchSpec {
    const launch = {
      command: '/bin/sh',
      args: [
        '-c',
        LAUNCHER,
        'tade-codex',
        threadFile(spec.task, this.opts.runDir),
        this.opts.account?.kind === 'api-key' ? (this.opts.account.key ?? '') : '',
        this.opts.bin,
        ...this.overrides(spec, { hooks: true }),
        // Tade's own gate decides what is held; Codex asking as well would
        // ask twice, in a lane nobody may be looking at.
        '--ask-for-approval',
        'never',
        // Codex's own containment, turned off: what an agent may reach is
        // the harness's business and never Tade's, and Tade's gate is what
        // decides here. Its flag, not a setting of ours.
        '--sandbox',
        'danger-full-access',
        // Tade wrote the hooks it is being given, one launch at a time.
        '--dangerously-bypass-hook-trust',
        // `--skip-git-repo-check` belongs to `codex exec` and nowhere else:
        // given to the one that draws a terminal, Codex refuses the line and
        // the lane holds a usage message instead of an agent. What answers
        // the question in a terminal is the folder being trusted, above.
        ...this.opts.args,
      ],
    }
    return {
      ...launch,
      env: this.runEnv(spec),
      // Its first message, said at the first launch only.
      ...(spec.prompt
        ? { opening: [promptWithImages(spec.prompt, spec.images, this.filesDir(spec.run))] }
        : {}),
    }
  }

  async supervise(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    const channel = await CodexChannel.listen({
      path: runSocket(this.opts.socketDir, spec.run),
      onRequest: (request) => this.onRequest(spec.run, request),
      onWarning: this.opts.onWarning,
    })
    this.runs.set(spec.run, await this.newRun(spec, { channel }))
    return { ...(this.runs.get(spec.run) as Run).handle }
  }

  /**
   * Run Codex as a child of ours, under its own event stream rather than
   * drawing a terminal: what the thing you talk to needs, since Tade draws
   * that conversation itself.
   *
   * Codex runs one instruction to the end and exits, so a turn is a process:
   * each one resumes the same thread, which is what keeps it one conversation.
   * Nothing is gated here — it is Tade's own interface — so the only hook it
   * is given is the one that tells it what Tade is.
   */
  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    const channel = await CodexChannel.listen({
      path: runSocket(this.opts.socketDir, spec.run),
      onRequest: (request) => this.onRequest(spec.run, request),
      onWarning: this.opts.onWarning,
    })
    const run = await this.newRun(spec, { channel, headless: true })
    this.runs.set(spec.run, run)
    this.say(run, { type: 'started', sessionId: run.thread, model: run.model, thinking: null })
    if (spec.prompt.trim()) await this.prompt(spec.run, spec.prompt, spec.images ?? [])
    return { ...run.handle }
  }

  private async newRun(
    spec: WorkerSpec,
    opts: { channel: CodexChannel; headless?: boolean },
  ): Promise<Run> {
    const thread = await threadOf(spec.task, this.opts.runDir)
    return {
      handle: {
        run: spec.run,
        task: spec.task,
        sessionId: thread,
        startedAt: Date.now(),
        lane: spec.lane ?? null,
      },
      spec,
      channel: opts.channel,
      headless: opts.headless === true,
      child: null,
      stderr: '',
      turn: opts.headless ? 'idle' : 'starting',
      queued: [],
      naming: null,
      typing: Promise.resolve(),
      held: new Map(),
      calls: new Map(),
      named: Boolean(spec.title),
      titled: false,
      told: contextFor(spec),
      thread,
      // A conversation it comes back to arrives with its history, which was
      // counted by whoever was watching then: counted from here, not from zero.
      spent: await spentOn(spec.task, this.opts.runDir, this.opts.codexHome),
      model: spec.model ? modelName(spec.model) : null,
      fullness: null,
      dir: this.filesDir(spec.run),
      events: Promise.resolve(),
    }
  }

  async prompt(
    run: RunId,
    message: string,
    images: readonly WorkerImage[] = [],
    opts: { whenBusy?: 'steer' | 'queue' } = {},
  ): Promise<void> {
    const entry = this.require(run)
    const text = promptWithImages(message, images, entry.dir)
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

  /** What it is thinking with, as its hooks or its events last said. */
  async modelOf(run: RunId): Promise<WorkerModel | null> {
    const entry = this.require(run)
    return entry.model ? { provider: 'openai', id: entry.model } : null
  }

  async setModel(_run: RunId, _model: WorkerModel): Promise<void> {
    // Never typed as `/model`: in Codex that is a menu a person picks from,
    // and what it saves is not this session's business alone.
    throw new Error(`Codex ${this.capabilities.why.model}`)
  }

  async setThinking(_run: RunId, _level: ThinkingLevel): Promise<void> {
    throw new Error(`Codex ${this.capabilities.why.thinking}`)
  }

  async name(run: RunId, title: string): Promise<void> {
    const entry = this.require(run)
    const flat = title.replace(/\s+/g, ' ').trim()
    if (!flat) return
    entry.named = true
    if (entry.child) return
    if (entry.turn === 'idle') await this.type(entry, `/rename ${flat}`)
    else entry.naming = flat
  }

  async abort(run: RunId): Promise<void> {
    const entry = this.require(run)
    if (entry.turn !== 'running') return
    entry.aborting = true
    if (entry.child) {
      // A turn is a process here: ending it is how it is stopped, and what it
      // said so far is already in the thread.
      this.kill(entry.child)
      return
    }
    // Escape, as a key and not as text. Its Interrupt hook says the turn
    // ended; this says so too, for a Codex that ran none.
    await this.inTurn(entry, () => this.keys(entry, '\x1b'))
    this.settle(entry, 'aborted')
  }

  async stop(run: RunId): Promise<void> {
    const entry = this.require(run)
    if (entry.child) this.kill(entry.child)
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
        entry.model = str('model') ?? entry.model
        await this.learnThread(entry, str('session_id'))
        this.say(entry, {
          type: 'started',
          sessionId: entry.thread,
          model: entry.model,
          thinking: null,
        })
        // Anything said before it could listen, said now it can.
        setTimeout(() => void this.flush(entry), 500).unref?.()
        // What Tade's extensions give this agent, said at every session start:
        // appended to Codex's own instructions, never replacing them.
        return entry.told
          ? {
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: entry.told,
              },
            }
          : null
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
        // Codex takes only a refusal from this hook: saying nothing is how it
        // is told to carry on, and a refusal has to say why.
        if (decision.allow) return null
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason || 'refused in Tade',
          },
        }
      }
      case 'PostToolUse': {
        this.say(entry, {
          type: 'tool_result',
          callId: str('tool_use_id') ?? '',
          ok: true,
          summary: '',
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
      case 'Interrupt': {
        // Codex says when a turn was cut short, so nothing here has to be
        // guessed from what it drew.
        await this.sayUsage(entry)
        this.settle(entry, 'aborted')
        return null
      }
      case 'SessionEnd': {
        // Codex is gone: a turn still open ended with it, and never finished.
        if (entry.turn === 'running') this.settle(entry, 'aborted')
        entry.turn = 'starting'
        return null
      }
      default:
        return null
    }
  }

  /** Write down the thread Codex made, so the next launch comes back to it. */
  private async learnThread(entry: Run, thread: string | null): Promise<void> {
    if (!thread || thread === entry.thread) return
    entry.thread = thread
    entry.handle.sessionId = thread
    await rememberThread(entry.handle.task, this.opts.runDir, thread).catch((err: unknown) =>
      this.opts.onWarning(
        `could not write down which Codex thread ${entry.handle.task} talks in, so it will start a new one next time: ${(err as Error).message}`,
      ),
    )
  }

  /**
   * What the turn spent, how full the context is and how much of the plan is
   * used, from Codex's own rollout: the ledger, read as the turn ends.
   */
  private async sayUsage(entry: Run): Promise<void> {
    if (!entry.thread) return
    const file = await rolloutFor(entry.thread, this.opts.codexHome)
    if (!file) return
    const text = await readFile(file, 'utf8').catch(() => '')
    if (!text) return
    const limits = limitsIn(text, Date.now())
    if (limits) this.planLimits = limits
    const full = contextIn(text)
    if (full && full.percent !== entry.fullness) {
      entry.fullness = full.percent
      this.say(entry, { type: 'context', tokens: full.tokens, percent: full.percent })
    }
    const now = spentIn(text)
    const was = entry.spent
    const tokens = now.tokens - was.tokens
    if (tokens <= 0) return
    entry.spent = now
    if (now.model) entry.model = now.model
    this.say(entry, {
      type: 'usage',
      model: now.model,
      input: now.input - was.input,
      output: now.output - was.output,
      cacheRead: now.cacheRead - was.cacheRead,
      cacheWrite: now.cacheWrite - was.cacheWrite,
      tokens,
      // Codex prices nothing it writes down, so nothing is made up here.
      usd: 0,
    })
  }

  /** A turn is over: say how, then say whatever was waiting for it to be. */
  private settle(entry: Run, status: 'ok' | 'error' | 'aborted', reason?: string): void {
    if (entry.turn !== 'running') return
    entry.turn = 'idle'
    const aborted = entry.aborting === true
    entry.aborting = false
    this.say(entry, {
      type: 'turn_done',
      status: aborted ? 'aborted' : status,
      ...(reason ? { reason } : {}),
    })
    this.say(entry, { type: 'idle' })
    // After Codex has drawn its prompt again: typed into a turn that is still
    // closing, it would be taken as a steer into it.
    setTimeout(() => void this.flush(entry), 300).unref?.()
  }

  // --- a turn as a process, for the one Tade draws itself -------------------------

  /** Start a turn: `codex exec`, on this run's own thread, printing its events. */
  private async runTurn(entry: Run, message: string): Promise<void> {
    const spec = entry.spec
    const launch = {
      command: this.opts.bin,
      args: [
        'exec',
        ...(entry.thread ? ['resume', entry.thread] : []),
        ...this.overrides(spec, { hooks: true, gate: false }),
        // Codex's own flag, as above: containment is the harness's to decide.
        '--sandbox',
        'danger-full-access',
        '--dangerously-bypass-hook-trust',
        '--skip-git-repo-check',
        '--json',
        ...this.opts.args,
        // Read from standard input: what is said never goes on a command
        // line, where every process table would have it.
        '-',
      ],
    }
    // It has no lane to carry on in and nobody could find it again, so it
    // does not outlive Tade — however Tade ends.
    const watched = reaped(launch)
    const child = spawn(watched.command, watched.args, {
      cwd: spec.cwd,
      env: { ...this.accountEnv(), ...this.runEnv(spec), ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, like everything Tade starts: a long-lived model
      // process in the terminal's foreground group is what the terminal names
      // its window after.
      detached: true,
    })
    entry.child = child
    entry.stderr = ''
    entry.turn = 'running'
    this.say(entry, { type: 'turn_started' })
    let rest = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        const line = rest.slice(0, end).trim()
        rest = rest.slice(end + 1)
        if (line) entry.events = entry.events.then(() => this.onEvent(entry, line)).catch(() => {})
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      entry.stderr = (entry.stderr + chunk.toString('utf8')).slice(-4_000)
    })
    // `close` rather than `exit`: the last of what a turn printed can still be
    // on its way when the process is already gone, and a turn that ended
    // before its own last line was read is one whose answer went missing.
    child.on('close', (code) => {
      entry.child = null
      void entry.events.then(() => this.ended(entry, code))
    })
    child.on('error', (err) => {
      entry.child = null
      this.say(entry, { type: 'failed', error: `Codex would not start: ${err.message}` })
      this.settle(entry, 'error', err.message)
    })
    child.stdin?.end(message)
  }

  /** A turn's process is gone, and everything it printed has been read. */
  private ended(entry: Run, code: number | null): void {
    if (entry.turn === 'running') {
      // A process that ended before it said anything says why from what it
      // wrote, rather than leaving a caller waiting on a turn that never comes.
      if (code !== 0 && code !== null && entry.aborting !== true) {
        this.say(entry, { type: 'failed', error: exitReason(code, entry.stderr ?? '') })
      }
      this.settle(entry, code === 0 ? 'ok' : 'error')
    }
    void this.flush(entry)
  }

  /** What a turn printed, line by line, as Tade's own signals. */
  private async onEvent(entry: Run, line: string): Promise<void> {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not ours to read: anything Codex prints that is not its event stream.
      return
    }
    const item = (event.item ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'thread.started': {
        const thread = typeof event.thread_id === 'string' ? event.thread_id : null
        await this.learnThread(entry, thread)
        return
      }
      case 'turn.started':
        return
      case 'item.started': {
        const tool = itemTool(item)
        if (tool) {
          this.say(entry, {
            type: 'tool_call',
            callId: String(item.id ?? ''),
            tool,
            input: item,
          })
        }
        return
      }
      case 'item.completed': {
        if (item.type === 'agent_message') {
          const text = typeof item.text === 'string' ? item.text : ''
          if (text.trim()) this.say(entry, { type: 'message', text })
          return
        }
        if (item.type === 'error') {
          const said = String(item.message ?? '')
          // Codex says the flags Tade passed back to it as items; they are
          // what Tade asked for, not something anybody has to go and fix.
          if (said && !said.includes('--dangerously-')) {
            this.say(entry, { type: 'problem', text: said })
          }
          return
        }
        if (itemTool(item)) {
          const code = item.exit_code
          this.say(entry, {
            type: 'tool_result',
            callId: String(item.id ?? ''),
            ok: item.status !== 'failed' && (typeof code !== 'number' || code === 0),
            summary:
              item.status === 'failed' ? String(item.aggregated_output ?? '').slice(0, 300) : '',
          })
        }
        return
      }
      case 'turn.completed': {
        this.sayTurnUsage(entry, event.usage)
        this.settle(entry, 'ok')
        return
      }
      case 'turn.failed': {
        const error = (event.error ?? {}) as Record<string, unknown>
        this.settle(entry, 'error', String(error.message ?? 'the model returned an error'))
        return
      }
      case 'error': {
        this.say(entry, { type: 'problem', text: String(event.message ?? '') })
        return
      }
      default:
        return
    }
  }

  /** What a turn consumed, as its own event stream counts it. */
  private sayTurnUsage(entry: Run, usage: unknown): void {
    if (typeof usage !== 'object' || usage === null) return
    const said = usage as Record<string, unknown>
    const num = (key: string) => (typeof said[key] === 'number' ? (said[key] as number) : 0)
    const cacheRead = num('cached_input_tokens')
    const input = Math.max(0, num('input_tokens') - cacheRead)
    const output = num('output_tokens')
    const cacheWrite = num('cache_write_input_tokens')
    const tokens = input + output + cacheRead + cacheWrite
    if (tokens <= 0) return
    entry.spent = {
      ...entry.spent,
      input: entry.spent.input + input,
      output: entry.spent.output + output,
      cacheRead: entry.spent.cacheRead + cacheRead,
      cacheWrite: entry.spent.cacheWrite + cacheWrite,
      tokens: entry.spent.tokens + tokens,
      messages: entry.spent.messages + 1,
    }
    this.say(entry, {
      type: 'usage',
      model: entry.model,
      input,
      output,
      cacheRead,
      cacheWrite,
      tokens,
      usd: 0,
    })
  }

  private kill(child: ChildProcess): void {
    const pid = child.pid
    if (!pid) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }

  // --- what we say to it ----------------------------------------------------------

  private async steerOn(entry: Run, message: string): Promise<void> {
    // A turn is a process when Tade draws the conversation itself, and a
    // process that is running takes nothing more: it is said as the next turn,
    // which is what "after this one" means anyway.
    if (entry.headless) return this.sendHeadless(entry, message)
    // In a lane, before the session has begun, there is nothing to type into.
    if (entry.turn === 'starting') entry.queued.push(message)
    else await this.type(entry, message)
  }

  private async queueOn(entry: Run, message: string): Promise<void> {
    if (entry.headless) return this.sendHeadless(entry, message)
    if (entry.turn === 'idle') await this.type(entry, message)
    else entry.queued.push(message)
  }

  private async sendHeadless(entry: Run, message: string): Promise<void> {
    if (entry.turn === 'running') {
      entry.queued.push(message)
      return
    }
    await this.runTurn(entry, message)
  }

  private async flush(entry: Run): Promise<void> {
    if (entry.turn !== 'idle' || !this.runs.has(entry.handle.run)) return
    // Taken at once, before anything waits: a second flush finds nothing left.
    const naming = entry.naming
    entry.naming = null
    const said = entry.queued.splice(0).join('\n\n')
    if (naming && !entry.headless) await this.type(entry, `/rename ${naming}`).catch(() => {})
    if (!said) return
    if (entry.headless) {
      await this.runTurn(entry, said).catch((err: unknown) =>
        this.say(entry, {
          type: 'problem',
          text: `could not start a turn in Codex: ${(err as Error).message}`,
        }),
      )
      return
    }
    await this.type(entry, said).catch((err: unknown) =>
      this.say(entry, {
        type: 'problem',
        text: `could not say a queued message to Codex: ${(err as Error).message}`,
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
    if (!this.opts.type) throw new Error('there is no terminal to type into for Codex')
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
    // Nothing left to answer them: a held call is refused rather than left
    // hanging, and Codex's hook says so under `policy`.
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
    for (const name of INHERITED_KEYS) delete env[name]
    if (this.ownFolder()) env.CODEX_HOME = this.opts.codexHome
    return env
  }

  private runEnv(spec: WorkerSpec): Record<string, string> {
    const env: Record<string, string> = {
      [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
      [WORKER_ENV.approvals]: this.opts.approvals,
      [WORKER_ENV.run]: spec.run,
      [WORKER_ENV.task]: spec.task,
    }
    if (spec.extras?.tools) env[WORKER_ENV.tools] = spec.extras.tools
    if (spec.title) env[WORKER_ENV.title] = spec.title
    if (this.ownFolder()) env.CODEX_HOME = this.opts.codexHome
    return env
  }

  /**
   * What this run is handed, as settings on the command line rather than in
   * anybody's own config: the hooks it reports through, the server that lends
   * it Tade's tools, the folder it is allowed to work in, and the model and
   * effort it was given. Written the same every time, so the line stays the
   * same.
   */
  private overrides(spec: WorkerSpec, opts: { hooks: boolean; gate?: boolean }): string[] {
    const args: string[] = []
    if (opts.hooks) {
      args.push('-c', `hooks=${toml(this.hooks(opts.gate !== false))}`)
    }
    const servers = this.mcpServers(spec)
    if (Object.keys(servers).length > 0) args.push('-c', `mcp_servers=${toml(servers)}`)
    // A folder Codex has never worked in stops it with a question before
    // anything starts; the folders Tade starts agents in are answered here,
    // for this launch alone. Said under the name Codex uses — the real path,
    // since a worktree under /var on macOS is /private/var to it — and under
    // the one Tade was given, because one of them is what it will look up.
    args.push('-c', `projects=${toml(trusted(spec.cwd))}`)
    if (spec.model) args.push('-m', modelName(spec.model))
    if (spec.thinking) args.push('-c', `model_reasoning_effort=${toml(effortOf(spec.thinking))}`)
    return args
  }

  /** The hooks a run reports through, each running Tade's own hook program. */
  private hooks(gate: boolean): Record<string, unknown> {
    const command = `${shellWord(process.execPath)} ${shellWord(HOOK_PATH)}`
    const hook = (timeout: number) => [{ hooks: [{ type: 'command', command, timeout }] }]
    return {
      SessionStart: hook(30),
      ...(gate
        ? {
            UserPromptSubmit: hook(30),
            // Held for as long as a person takes to answer, under `policy`.
            PreToolUse: hook(24 * 60 * 60),
            PostToolUse: hook(30),
            Stop: hook(30),
            // Codex caps these two at three seconds and says so in the lane
            // when asked for more; neither waits on anybody, so three is all
            // they were ever going to need.
            Interrupt: hook(LATE_S),
            SessionEnd: hook(LATE_S),
          }
        : {}),
    }
  }

  /**
   * The MCP servers this run may call: Tade's own, and the ones extensions
   * gave it, read out of the files they were written to and said again in
   * Codex's own words.
   */
  private mcpServers(spec: WorkerSpec): Record<string, unknown> {
    const servers: Record<string, unknown> = {
      tade: {
        command: process.execPath,
        args: [MCP_PATH],
        env: {
          [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
          [WORKER_ENV.run]: spec.run,
          [WORKER_ENV.task]: spec.task,
          ...(spec.extras?.tools ? { [WORKER_ENV.tools]: spec.extras.tools } : {}),
        },
        startup_timeout_sec: 60,
        // A tool Tade runs may take minutes: longer than Codex waits by default.
        tool_timeout_sec: 15 * 60,
      },
    }
    for (const file of spec.extras?.mcp ?? []) {
      for (const [name, config] of Object.entries(readServers(file, this.opts.onWarning))) {
        if (name !== 'tade') servers[name] = config
      }
    }
    return servers
  }

  private filesDir(run: string): string {
    return join(
      this.opts.runDir,
      'codex',
      createHash('sha1').update(run).digest('hex').slice(0, 12),
    )
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * A folder marked as one this account trusts, under every name Codex might
 * look it up by. Codex asks about a folder it has not worked in before, and
 * asks by the real path: on macOS a temporary worktree given as `/var/...` is
 * `/private/var/...` to it, and the answer under the other name is no answer
 * at all.
 */
function trusted(cwd: string): Record<string, { trust_level: 'trusted' }> {
  const names = new Set([cwd])
  try {
    names.add(realpathSync(cwd))
  } catch {
    // A folder that is not there yet is named as it was given.
  }
  return Object.fromEntries([...names].map((name) => [name, { trust_level: 'trusted' as const }]))
}

/** A word the shell reads back as itself. */
function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Where a run's supervision socket lives: hashed, because a long path fails to bind. */
export function runSocket(dir: string, run: string): string {
  return join(dir, `x-${createHash('sha1').update(run).digest('hex').slice(0, 12)}.sock`)
}

/** A model as Codex takes it: its own slug, never a provider's prefix. */
export function modelName(model: WorkerModel): string {
  return model.id.includes('/') ? (model.id.split('/').at(-1) ?? model.id) : model.id
}

/** A thinking level as Codex's `model_reasoning_effort`: it has no "off", so the least it has. */
export function effortOf(level: ThinkingLevel): string {
  return EFFORTS.includes(level) ? level : 'minimal'
}

/** Tade's own tools by their own names; everything else as Codex calls it. */
export function toolName(name: string): string {
  return name.startsWith(OURS) ? name.slice(OURS.length) : name
}

/** How a Codex login says it is signed in, or null for one that says it is not. */
export function methodIn(said: string): string | null {
  const line = said
    .split('\n')
    .map((one) => one.trim())
    .find((one) => /^(Logged in|Not logged in)/.test(one))
  if (!line || line.startsWith('Not logged in')) return null
  const how = line
    .replace(/^Logged in using\s*/i, '')
    .split(' - ')[0]
    ?.trim()
  return how ? how.toLowerCase() : 'signed in'
}

/**
 * The models Codex offers, out of its own catalog. Anything it prints that is
 * not that catalog reads as no models rather than as an invented one.
 */
export function catalogIn(said: string): HarnessModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(said)
  } catch {
    return []
  }
  const models = (parsed as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  const found: HarnessModel[] = []
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Record<string, unknown>
    if (typeof one.slug !== 'string' || !one.slug) continue
    // Codex hides the models it is not offering people; they are still real,
    // and choosing one nobody is shown is not something to offer.
    if (one.visibility === 'hide') continue
    const window = one.context_window
    found.push({
      id: `openai/${one.slug}`,
      provider: 'openai',
      name: typeof one.display_name === 'string' ? one.display_name : one.slug,
      ...(typeof window === 'number' && window > 0 ? { contextWindow: window } : {}),
    })
  }
  return found
}

/** Why a turn's process ended, from what it wrote before it did. */
export function exitReason(code: number | null, stderr: string): string {
  const said = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return said || `Codex exited with code ${code ?? 'unknown'}`
}

/** What a started item is a call of, when it is one: null for everything else. */
function itemTool(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case 'command_execution':
      return 'shell'
    case 'file_change':
      return 'apply_patch'
    case 'mcp_tool_call':
      return toolName(String(item.tool ?? item.name ?? 'mcp_tool_call'))
    case 'web_search':
      return 'web_search'
    default:
      return null
  }
}

/**
 * The MCP servers a config file names, in Codex's own words. A file that is
 * not one, or a server said in a shape Codex has no place for, is warned about
 * and left out rather than thrown over.
 */
function readServers(
  file: string,
  warn: (message: string) => void,
): Record<string, Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    warn(`could not read the MCP servers in ${file} for Codex: ${(err as Error).message}`)
    return {}
  }
  const said = (parsed as { mcpServers?: unknown } | null)?.mcpServers
  if (typeof said !== 'object' || said === null) return {}
  const servers: Record<string, Record<string, unknown>> = {}
  for (const [name, raw] of Object.entries(said as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Record<string, unknown>
    if (typeof one.command === 'string') {
      servers[name] = {
        command: one.command,
        ...(Array.isArray(one.args) ? { args: one.args.map(String) } : {}),
        ...(typeof one.env === 'object' && one.env !== null ? { env: one.env } : {}),
      }
    } else if (typeof one.url === 'string') {
      servers[name] = { url: one.url }
    } else {
      warn(`the MCP server ${name} in ${file} is said in a shape Codex has no place for`)
    }
  }
  return servers
}

/**
 * What Tade's extensions give this agent, in words: their instructions, and
 * the skills they ship, named with where to read them — Codex finds skills in
 * its own folders, and Tade does not write into those.
 */
export function contextFor(spec: WorkerSpec): string {
  const parts: string[] = []
  if (spec.extras?.instructions) parts.push(spec.extras.instructions.trim())
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
  const fallback = { name: dir.split('/').filter(Boolean).at(-1) ?? dir, description: 'a skill' }
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
      if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ')
    }
    return ''
  }
  switch (tool) {
    case 'Bash':
    case 'shell':
    case 'unified_exec':
      return `${tool}: ${first('command', 'cmd', 'input')}`
    case 'Write':
    case 'Edit':
    case 'Read':
    case 'apply_patch':
      return `${tool} ${first('file_path', 'path', 'changes')}`
    default:
      return `${tool} ${JSON.stringify(fields).slice(0, 200)}`
  }
}

/** A name from what was asked: its first line, politeness taken off, eight words at most. */
export function firstWords(text: string, words = 8): string {
  const line = text
    .split('\n')
    .map((one) => one.trim())
    .find((one) => one.length > 0)
  if (!line) return ''
  const said = line
    .replace(/^(please|could you|can you|hey|hi|ok|okay)[,\s]+/i, '')
    .replace(/^[/@]\S+\s*/, '')
    .trim()
  const taken = said.split(/\s+/).slice(0, words).join(' ')
  return taken.length > 80 ? `${taken.slice(0, 77)}...` : taken
}
