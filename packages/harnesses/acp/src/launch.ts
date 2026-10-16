import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AcpAgent } from './agents.ts'
import type { McpServer } from './protocol.ts'

// What a lane is started with, written down by the adapter beside the run and
// read by the lane as it starts: which agent, which model within it, what Tade
// tells every agent, and the MCP servers its session is handed. A file rather
// than arguments, because the line Tade writes down to come back to an agent
// has to stay the same line, and none of this is the person's to see in it.

export interface LaneLaunch {
  /** Where the conversation is written down. */
  record: string
  /** The agent asked for, by id; null leaves the choice to the first one here. */
  agent: string | null
  /** The model within it, where one was chosen. */
  model: string | null
  /** Every agent this harness is configured to drive. */
  agents: AcpAgent[]
  instructions: string
  mcpServers: McpServer[]
}

/** The launch a lane was given, or why it cannot be read. */
export function readLaunch(path: string): LaneLaunch {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LaneLaunch>
  if (typeof raw.record !== 'string' || !Array.isArray(raw.agents)) {
    throw new Error(`${path} is not a launch Tade wrote`)
  }
  return {
    record: raw.record,
    agent: typeof raw.agent === 'string' ? raw.agent : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    agents: raw.agents,
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
  }
}

/** Where a program is on the PATH, or null when nothing there answers to its name. */
export function onPath(command: string, path = process.env.PATH ?? ''): string | null {
  if (command.includes('/')) return isRunnable(command) ? command : null
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (isRunnable(candidate)) return candidate
  }
  return null
}

function isRunnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Which agent a lane runs: the one its conversation is already in, then the
 * one asked for, then the first configured one that is on this machine —
 * and why, in words, when it is not the one asked for.
 */
export function chooseAgent(
  launch: Pick<LaneLaunch, 'agent' | 'agents'>,
  recorded: string | null,
  path = process.env.PATH ?? '',
): { agent: AcpAgent; why: string | null } | { agent: null; why: string } {
  const byId = (id: string | null) => launch.agents.find((one) => one.id === id) ?? null
  const kept = byId(recorded)
  if (kept) {
    return {
      agent: kept,
      why:
        launch.agent && launch.agent !== kept.id
          ? `its conversation is with ${kept.title}, so it stays there rather than moving to ${launch.agent}`
          : null,
    }
  }
  const asked = byId(launch.agent)
  if (asked) return { agent: asked, why: null }
  if (launch.agent) {
    return { agent: null, why: `no agent called ${launch.agent} is configured for the acp harness` }
  }
  const here = launch.agents.find((one) => onPath(one.command, path) !== null)
  if (here)
    return { agent: here, why: `no agent was chosen, so it runs ${here.title}, the first one here` }
  return {
    agent: null,
    why: `none of the agents the acp harness drives is installed here: ${launch.agents.map((one) => one.command).join(', ')}`,
  }
}
