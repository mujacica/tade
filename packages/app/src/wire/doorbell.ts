import {
  type Config,
  doorbellRings,
  expandHome,
  findSecret,
  HOOK_SECRETS,
  type HookAddress,
  type HookSource,
  type WatchDoorbell,
} from '@tade/core'
import { repositoryAt } from '@tade/status'
import { inTime, type WebHooks } from '@tade/web'
import type { Wiring } from './context.ts'

// The window's half of the doorbell (`@tade/web`'s `hooked.ts`,
// REMOTE-TADE.md §6.1): the secret each source signs with, which schedules a
// delivery that verified is for, and waking them.
//
// **A delivery makes a schedule look now, through the look its clock uses**
// (`Schedules.wake`) — so the look reads the source under the grant, the keys
// Tade keeps deduplicate what it finds, and `propose` parks what it makes,
// exactly as the same look ten minutes later would. Nothing a delivery says
// reaches the look: it only chose which one.
//
// **Which schedules is what each watch declares** (`ExtensionWatch.doorbell`):
// its source, the kinds of delivery that can change what it finds, and the
// input — or the project's own repository — a delivery's address is matched
// on. A paused schedule is not woken; one whose watch another machine looks
// with is, and its look is the quiet one `notLooking` writes.

/** How long git may take to say which repository a project is, before that project is left unwoken. */
const REPOSITORY_MS = 3_000

/** What the doorbell needs of the schedules subject: one look now, by id. */
export interface Waking {
  wake(id: string): void
}

/** The window's `WebHooks`, over its config, its schedules and the watches its extensions declare. */
export function hooksFor(wire: Wiring, config: () => Config, schedules: Waking): WebHooks {
  return {
    secret: (source) => secretOf(config(), source),
    match: (address) => doorbellFor(wire, config(), address),
    wake: (ids) => {
      for (const id of ids) schedules.wake(id)
    },
  }
}

/**
 * The secret one source signs with: `extensions.intake.<key>`, its variable
 * winning (`findSecret`, the one rule every key is read by). Null for none,
 * which is that source's route answering the `404` of a path nobody built.
 */
export function secretOf(config: Config, source: HookSource): string | null {
  const { key, env } = HOOK_SECRETS[source]
  return (
    findSecret({
      settings: config.extensions.intake,
      key,
      env: process.env,
      variables: [env],
    })?.value ?? null
  )
}

/**
 * Which schedules one delivery is for, by id: every watch schedule that is on,
 * whose watch's doorbell is from that source and rings for that kind of
 * delivery, about the channel, team or repository the delivery named.
 *
 * A project's repository is asked of git once per delivery and with a
 * deadline (`repositoryAt`, which keeps what it read while the checkout's
 * config has not changed); one that does not answer in time is a project not
 * woken, which its own poll then covers. Nothing is caught: `repositoryAt`
 * answers null for every checkout git cannot name — not one, a broken `.git`,
 * no remote — since its git runs with `reject: false`, so whatever else it
 * threw would be news.
 */
export async function doorbellFor(
  wire: Wiring,
  config: Config,
  address: HookAddress,
): Promise<string[]> {
  const bells = new Map<string, WatchDoorbell>()
  for (const offer of wire.opts.extensions?.watches() ?? []) {
    if (offer.doorbell?.source === address.source) bells.set(offer.id, offer.doorbell)
  }
  if (bells.size === 0) return []
  const repositories = new Map<string, Promise<string | null>>()
  const repositoryOf = (project: string): Promise<string | null> => {
    const configured = config.projects[project]
    if (configured === undefined) return Promise.resolve(null)
    let asked = repositories.get(project)
    if (asked === undefined) {
      asked = inTime(repositoryAt(expandHome(configured.root)), REPOSITORY_MS, null)
      repositories.set(project, asked)
    }
    return asked
  }
  const woke: string[] = []
  for (const one of wire.opts.client.schedules()) {
    if (one.paused || one.does.kind !== 'watch') continue
    const bell = bells.get(one.does.watch)
    if (bell === undefined) continue
    const repository =
      bell.input === undefined && address.where !== null ? await repositoryOf(one.project) : null
    if (doorbellRings(bell, address, { input: one.does.input, repository })) woke.push(one.id)
  }
  return woke
}
