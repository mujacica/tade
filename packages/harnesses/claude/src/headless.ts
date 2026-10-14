import { WORKER_ENV, type WorkerSpec } from '@tade/harnesses-core'

// How Claude Code is started as the conversation Tade draws itself — the
// orchestrator's: its command line and its environment. The process, the
// protocol and the signals are `ClaudeAdapter.start()`'s; this is only what
// it is started with, so a test can hold the line without a `claude`.

/** The option that stops Claude Code pinning the system prompt, where it has one. */
export const SNAPSHOT_OPTION = '--system-prompt-snapshot'

export interface HeadlessLaunch {
  /** MCP config files: the orchestrator's own tools, and anything else it was given. */
  mcp: readonly string[]
  session: string
  /** Whether the conversation already exists, so it is taken up rather than made. */
  going: boolean
  model: string | null
  effort: string | null
  instructions: string | null
  plugin: string | null
  /** Whether the Claude Code here takes `SNAPSHOT_OPTION` (`optionsOf`). */
  snapshot: boolean
  /** Whatever the adapter was configured to pass every launch. */
  extra: readonly string[]
}

/**
 * The orchestrator's line.
 *
 * **A conversation whose id never changes must not pin what it was first
 * told.** Claude Code records the system prompt on a conversation's first
 * request (`prompt_snapshot`) and sends that record on every later request and
 * every resume, whatever a later launch passes, until the conversation is
 * compacted. The orchestrator is one session for good (`sessionIdFor`), and
 * Tade writes its instructions — notes, the queue's rules, the briefing — fresh
 * every time the window opens, so nothing that changed reached the model.
 * `off` renders the prompt again on every request. Its cost is one uncached
 * turn whenever the prompt did change, which is the point.
 */
export function headlessArgs(launch: HeadlessLaunch): string[] {
  return [
    // Several values each, so first: last, they would swallow what follows.
    ...(launch.mcp.length > 0 ? ['--mcp-config', ...launch.mcp] : []),
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
    ...(launch.going ? ['--resume', launch.session] : ['--session-id', launch.session]),
    // Only where it is offered: an older Claude Code refuses an option it does
    // not know, and an orchestrator that never starts is worse than one that
    // remembers its first prompt.
    ...(launch.snapshot ? [SNAPSHOT_OPTION, 'off'] : []),
    '--permission-mode',
    'bypassPermissions',
    ...(launch.model ? ['--model', launch.model] : []),
    ...(launch.effort ? ['--effort', launch.effort] : []),
    ...(launch.instructions ? ['--append-system-prompt-file', launch.instructions] : []),
    ...(launch.plugin ? ['--plugin-dir', launch.plugin] : []),
    ...launch.extra,
  ]
}

/**
 * What a headless run is told about itself, on top of the account's
 * environment, with what its caller passed (`spec.env`) winning — but for one
 * thing.
 *
 * **Every tool is declared whole, every request** (`ENABLE_TOOL_SEARCH=false`).
 * With tool search on, Claude Code writes a tool's description and schema
 * down the first time it loads one (`deferred_tools_record`) and declares it
 * from that record for the rest of the conversation: a new process serving a
 * changed tool writes nothing new, and neither does loading it again, and the
 * snapshot option does not reach it. So the orchestrator kept a
 * `tade_queue_change` with no `after` and no `retell`, and changed queued work
 * the only way it could see — removing it and planning it again, under a new
 * name each time. Inline, the tools are what the server says today: about
 * twenty thousand tokens of Tade's, cached between turns, and the person's own
 * servers' with them. Set last, because `spec.env` is the window's whole
 * environment and a value inherited from wherever Tade was opened would
 * quietly undo it.
 */
export function headlessEnv(account: NodeJS.ProcessEnv, spec: WorkerSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...account }
  env[WORKER_ENV.run] = spec.run
  env[WORKER_ENV.task] = spec.task
  env.MCP_TOOL_TIMEOUT = String(15 * 60_000)
  if (spec.extras?.tools) env[WORKER_ENV.tools] = spec.extras.tools
  return { ...env, ...spec.env, ENABLE_TOOL_SEARCH: 'false' }
}
