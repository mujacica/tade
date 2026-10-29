import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionsRoot } from '@tade/core'
import { WORKER_ENV } from '@tade/harnesses-core'
import type { OrchestratorOptions } from './orchestrator.ts'

// What a harness is handed when the orchestrator starts: the environment its
// tools find their way back through, and the MCP server file for a harness
// that takes its tools that way.
//
// **Its own file because it is a different subject**, not because the other
// one was long: `orchestrator.ts` is the conversation — the lease, the gate,
// the signals, the turns — and this is the launch. The seam is that nothing
// here knows a turn exists.

/** The same tools, served over MCP to a harness that speaks it. */
export const TOOLS_MCP = fileURLToPath(new URL('./tools-mcp.ts', import.meta.url))
/** What that server is called in the config it is handed in: what a harness names it back by. */
export const TOOLS_SERVER = 'tade'
/** The `tade` CLI in a source checkout, which the status tool shells out to. */
const CLI_BIN = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))

/** Where approved lessons live, beside everything else Tade keeps. */
export function skillsRoot(opts: { home: string }): string {
  return join(opts.home, 'skills')
}

/**
 * What Tade's own tools are told, and nothing else: where to call back to,
 * where Tade keeps things, how to run the CLI that answers "where are we"
 * exactly as a person would see it, and which extension tools this
 * orchestrator was given.
 *
 * **This is all that goes in the file a harness is handed**, because a key is
 * never in a launch line or a file Tade writes for one (`withoutInherited`,
 * `secretCommand`): copying the whole environment in put every key the shell
 * that opened Tade exported into `tade-tools.mcp.json`. The rest reaches the
 * server the way any environment does: the harness that spawns it passes its
 * own down (Claude Code 2.1.308 does, the file's `env` laid over it), and the
 * harness was itself started with `toolEnv`. Every agent's own Tade server,
 * on every harness, has only ever been handed its `TADE_*` variables this way.
 */
export function toolsTold(opts: OrchestratorOptions): Record<string, string> {
  return {
    TADE_SOCKET: opts.socket,
    TADE_HOME: opts.home,
    // Where extensions live, so the tools do not have to guess at paths the
    // config may have moved.
    TADE_EXTENSIONS: extensionsRoot(opts.home, opts.config?.orchestrator.extensions),
    TADE_SKILLS: skillsRoot(opts),
    TADE_CLI: process.execPath,
    TADE_CLI_ARGS: CLI_BIN,
    // The extension tools listed for this run, said here rather than left to
    // whatever a harness happens to pass down to a server it spawns: pi's
    // adapter sets this from the same `extras`, and an orchestrator on one
    // harness silently had fewer tools than on another — a capability
    // difference nobody declared. Said as none rather than left out when
    // there are none, because Tade opened from inside an agent inherits that
    // agent's list, the server inherits it in turn, and the orchestrator's
    // tools are not an agent's.
    [WORKER_ENV.tools]: opts.extensions?.extras.tools ?? '',
  }
}

/**
 * The environment the orchestrator's harness is started with: the window's
 * own, with what Tade's tools are told laid over it (`toolsTold`).
 */
export function toolEnv(opts: OrchestratorOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(opts.env ?? process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, toolsTold(opts))
  if (!env[WORKER_ENV.tools]) delete env[WORKER_ENV.tools]
  // And **not** another agent's supervision, for the reason the tool list is
  // said as none (`toolsTold`), and with sharper teeth. Tade opened from inside an agent inherits that agent's
  // `TADE_RUN_SOCKET`, `TADE_RUN_ID`, `TADE_TASK_ID` and `TADE_APPROVALS`, and
  // this environment is handed to the harness as `spec.env`, which wins over
  // the adapter's own. So the orchestrator's supervision channel would be the
  // parent agent's socket: its tool calls reported against somebody else's
  // run, and its gate answered by whoever is holding that one. Left to the
  // adapter, which is the only thing that knows where this run's channel is.
  for (const inherited of [
    WORKER_ENV.socket,
    WORKER_ENV.run,
    WORKER_ENV.task,
    WORKER_ENV.approvals,
  ]) {
    delete env[inherited]
  }
  return env
}

/**
 * An MCP server that serves Tade's own tools, written where the harness that
 * starts it can find it: the same tools pi loads as an extension, in the
 * terms a harness that speaks MCP takes them.
 *
 * Exported so a test can start exactly what a harness would start, from
 * exactly the bytes it would read.
 */
export function writeToolServer(opts: OrchestratorOptions): string {
  const path = join(opts.runDir, 'tade-tools.mcp.json')
  mkdirSync(opts.runDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          [TOOLS_SERVER]: {
            type: 'stdio',
            command: process.execPath,
            args: [TOOLS_MCP],
            env: toolsTold(opts),
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return path
}
