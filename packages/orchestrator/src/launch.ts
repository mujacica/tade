import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from '@tade/core'
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
/** The `tade` CLI in a source checkout, which the status tool shells out to. */
const CLI_BIN = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))

/** Where approved lessons live, beside everything else Tade keeps. */
export function skillsRoot(opts: { home: string }): string {
  return join(opts.home, 'skills')
}

/**
 * What Tade's own tools are told, whichever harness loads them: where to call
 * back to, where Tade keeps things, how to run the CLI that answers "where
 * are we" exactly as a person would see it, and which extension tools this
 * orchestrator was given.
 */
export function toolEnv(opts: OrchestratorOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(opts.env ?? process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TADE_SOCKET = opts.socket
  env.TADE_HOME = opts.home
  // Where extensions live, so the tools do not have to guess at paths the
  // config may have moved.
  env.TADE_EXTENSIONS = expandHome(
    opts.config?.orchestrator.extensions ?? join(opts.home, 'extensions'),
  )
  env.TADE_SKILLS = skillsRoot(opts)
  env.TADE_CLI = process.execPath
  env.TADE_CLI_ARGS = CLI_BIN
  // The extension tools listed for this run, said here rather than left to
  // whatever a harness happens to pass down to a server it spawns: pi's
  // adapter sets this from the same `extras`, and nobody promises Claude Code
  // hands its own environment to an MCP server, so an orchestrator on one
  // silently had fewer tools than an orchestrator on the other — a capability
  // difference nobody declared. Taken back out when there are none, because
  // Tade opened from inside an agent inherits that agent's list, and the
  // orchestrator's tools are not an agent's.
  if (opts.extensions?.extras.tools) env[WORKER_ENV.tools] = opts.extensions.extras.tools
  else delete env[WORKER_ENV.tools]
  // And **not** another agent's supervision, for the same reason and with
  // sharper teeth. Tade opened from inside an agent inherits that agent's
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
          tade: { type: 'stdio', command: process.execPath, args: [TOOLS_MCP], env: toolEnv(opts) },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return path
}
