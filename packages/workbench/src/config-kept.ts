import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Config,
  type EventInput,
  parseConfig,
  resolveRoute,
  settingReach,
  type ThinkingLevel,
  writeSetting,
} from '@tade/core'
import { type ConfigChange, changeOf, heldIn } from './config-changes.ts'

// What the workbench writes into the config for itself: an account added,
// taken away or chosen for a harness, an account's API key, and the model or
// thinking a running agent was moved to, kept on its route for new agents.
//
// Through the one write path (`writeSetting`), read back so what was written
// is what runs, and every key that changed written down as `config_changed`
// the way the Settings page writes its own — because a change nobody watched
// has to be one somebody can find and undo. The workbench holds the journal,
// so it appends its own lines. **Never a key on one**: a credential is said as
// `set` or `not set`, and an account as a block, `set`, since its key is in it.

type Value = Parameters<typeof writeSetting>[2]

/** One key the workbench writes, and whether its value is a credential, which is never said. */
export interface KeptWrite {
  key: string
  value: Value
  secret?: boolean
}

/** The config as it loads after a write, and the lines that write leaves. */
export interface Kept {
  config: Config
  changes: ConfigChange[]
}

/**
 * Write `writes` into `home`'s config, in order, and read it back. Throws,
 * having put the file back exactly as it was, where it would not load: the
 * next window must never find a file it refuses.
 */
export function keptIn(home: string, writes: readonly KeptWrite[], by: string): Kept {
  const path = join(home, 'config.yaml')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  const held = heldIn(path)
  for (const one of writes) writeSetting(path, one.key, one.value)
  const parsed = parseConfig(readFileSync(path, 'utf8'), path)
  if (!parsed.ok) {
    if (before === null) rmSync(path, { force: true })
    else writeFileSync(path, before, { mode: 0o600 })
    throw new Error(`that would make config.yaml invalid: ${parsed.issues[0]?.message ?? ''}`)
  }
  const changes = writes.flatMap((one) => changeOf(held, one.key, one.value, by, one.secret) ?? [])
  return { config: parsed.config, changes }
}

/**
 * Write `changes` down in the journal the workbench holds, once the config is
 * written. Throws where the journal would not take one, saying the key is
 * written all the same: the line is what makes it a change somebody can undo.
 */
export async function recordKept(
  changes: readonly ConfigChange[],
  append: (line: EventInput) => Promise<unknown>,
): Promise<void> {
  for (const detail of changes) {
    try {
      await append({ type: 'config_changed', detail: { ...detail } })
    } catch (err) {
      throw new Error(
        `${detail.path} is written, but the journal would not take the line that says so: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/** What an agent was moved to, to keep for new agents. */
export interface RouteChange {
  provider?: string
  model?: string
  thinking?: ThinkingLevel
}

/** What became of keeping a change on a route for new agents: kept, or why not, in words. */
export type RouteKept = { kept: true } | { kept: false; why: string }

/**
 * Keep `change` on the route `task`'s project uses, as `by` asked — or say why
 * it was not kept, never thrown: the agent it was chosen for has switched
 * already, and an answer that reads as a failure would say it had not.
 *
 * **The orchestrator is held to `settingReach` here**, in the window's
 * process, and never in its tool, which runs inside pi: a route's `provider`
 * is `never` its to move, nor anything under a route but the route's own
 * model, thinking and harness (`ALLOWED_UNDER`). So what it asked for is kept
 * only where it changes nothing out of its reach — another model of the
 * provider the route already has, a thinking level on the route's own harness
 * — and otherwise none of it is, since a model kept without its provider is a
 * route nobody chose. The agent still switches; the route is the person's.
 */
export function keptOnRoute(
  home: string,
  config: Config,
  req: { task: string; change: RouteChange; harness: string | undefined; by: string },
): (Kept & { kept: true }) | { kept: false; why: string } {
  try {
    // Inside, because a route that cannot be found is one that cannot be written.
    const writes = routeWrites(config, req.task, req.change, req.harness)
    const held = heldIn(join(home, 'config.yaml'))
    const beyond = req.by === 'orchestrator' ? beyondReach(held, writes) : null
    if (beyond !== null) {
      return {
        kept: false,
        why: `${beyond} is not mine to change — ${settingReach(beyond).because}. Changing the route is the person's, in Settings (ctrl+,)`,
      }
    }
    return { kept: true, ...keptIn(home, writes, req.by) }
  } catch (err) {
    return {
      kept: false,
      why: `the route could not be written: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** The first of `writes` that would change a key no words of the orchestrator reach, over what is `held`. */
function beyondReach(held: unknown, writes: readonly KeptWrite[]): string | null {
  const beyond = writes.find(
    (one) =>
      settingReach(one.key).reach === 'never' && changeOf(held, one.key, one.value, '') !== null,
  )
  return beyond?.key ?? null
}

/**
 * Where what new agents in `task`'s project start on is kept: on the route the
 * project uses, which is where Settings shows the agent model — the route's own
 * keys when the agent runs in the route's harness, and beside them for any
 * other, so no harness is handed another's model.
 */
export function routeWrites(
  config: Config,
  task: string,
  change: RouteChange,
  harness?: string,
): KeptWrite[] {
  const project = task.split('/')[0]
  const route = resolveRoute(config, project ? { project } : {})
  const at =
    !harness || harness === route.harness
      ? `workers.routes.${route.name}`
      : `workers.routes.${route.name}.harnesses.${harness}`
  return Object.entries(change).map(([key, value]) => ({ key: `${at}.${key}`, value }))
}
