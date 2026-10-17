import {
  type Config,
  carriedSays,
  extensionEnabled,
  machineLabel,
  type SettingGroup,
  TALK_THERE,
  writtenAt,
} from '@tade/core'
import type { LoadedExtension } from '@tade/extensions-core'
import {
  type CarriedBy,
  carryingAt,
  inTime,
  type SignInHere,
  surfaceOf,
  type WebCarrying,
} from '@tade/web'
import type { AccountView } from '@tade/workbench/accounts'
import { configPathOf, notify, type Wiring, why } from './context.ts'
import type { Settings } from './settings.ts'

// Another machine's Tade carrying its setup into this one (`@tade/web`'s
// `carried.ts`): the window's half — what the away view's owner route reads
// and writes through. Every setting goes in by the window's own door
// (`Settings.writeKey`), so it is read back, applied now and written down as
// `config_changed` like any other, with the device and the machine it came
// from; a file goes into this home with a `carried_in` line beside it.
//
// **What goes back about the harnesses is whether each is signed in and until
// when** — `signInsOf` picks exactly that out of what each harness says, and
// nothing a harness keeps beside it, its token least of all.

/** How long a carry waits for the harnesses to say who they are signed in as. */
const SIGN_INS_MS = 15_000

/** The window's `WebCarrying`, over its own config, journal and harnesses. */
export function carryingFor(
  wire: Wiring,
  settings: Pick<Settings, 'writeKey' | 'rows'>,
): WebCarrying {
  const carrying: WebCarrying = carryingAt({
    home: wire.opts.home,
    configPath: configPathOf(wire.opts),
    lines: () => wire.opts.client.events({ types: ['config_changed', 'carried_in'] }),
    write: async (path, value, carry, by) => {
      const was = carriedSays(carry, writtenAt(await carrying.written(), path))
      // An extension's own setting is handed to the extensions by `writeKey`,
      // as from the Settings page; which extensions are on still waits for the
      // next start, as it does wherever it is changed.
      await settings.writeKey(path, value as Parameters<Settings['writeKey']>[1], was, {
        by: `device ${by.device}`,
        now: carriedSays(carry, value),
        carried: by.from,
      })
    },
    log: async (line) => {
      await wire.opts.client.log.append(line)
    },
    // A harness that will not say in time is left out, which the machine that
    // asked reads as "cannot tell" for it — never as signed out.
    signIns: async () => signInsOf(await inTime(wire.opts.client.accounts(), SIGN_INS_MS, [])),
    machine: machineLabel(),
    started: wire.openedAt,
    waiting: (paths) =>
      waitingHere(paths, settings.rows(), wire.opts.config, wire.opts.extensions?.list() ?? []),
    talk: {
      on: () => surfaceOf(wire.opts.config.surfaces.web).talking,
      turnOn: (by) => turnTalkOn(wire, settings, by),
    },
  })
  return carrying
}

/**
 * Talking to Tade from another screen turned on here, on an owner's press: by
 * the window's own door, so it applies now — the listener is built again with
 * the routes that take a message — and is written down as that device's. Never
 * throws: what went wrong is said here, and the next carry finds it still off
 * and says so there.
 */
async function turnTalkOn(
  wire: Wiring,
  settings: Pick<Settings, 'writeKey'>,
  by: CarriedBy,
): Promise<void> {
  try {
    const was = String(wire.opts.config.surfaces.web.orchestrator)
    await settings.writeKey(TALK_THERE, true, was, { by: `device ${by.device}` })
  } catch (err) {
    notify(
      wire,
      `Talking to Tade from another screen was not turned on, as ${by.from} asked: ${why(err)}`,
    )
    wire.draw()
  }
}

/**
 * Of these paths, the ones a change to waits for Tade to start again here: a
 * row Settings says is not live — what it says where somebody changes one here
 * — an extension that is on and not running, one of yours, which is never
 * imported mid-session, and an MCP server that is on.
 */
export function waitingHere(
  paths: readonly string[],
  rows: readonly SettingGroup[],
  config: Pick<Config, 'extensions' | 'mcp'>,
  loaded: readonly Pick<LoadedExtension, 'name' | 'source' | 'state'>[],
): Set<string> {
  const settings = rows.flatMap((group) => group.settings)
  const live = new Map(settings.map((one) => [one.path, one.live]))
  // A model is chosen as provider/id and kept as two keys (`modelChosen`), so
  // the row at `<x>.model` is the one somebody changed a provider with too.
  for (const one of settings) {
    if (one.type.kind !== 'model' || !one.path.endsWith('.model')) continue
    const provider = `${one.path.slice(0, -'model'.length)}provider`
    if (!live.has(provider)) live.set(provider, one.live)
  }
  const waiting = new Set<string>()
  for (const path of paths) {
    const row = live.get(path)
    if (row !== undefined) {
      if (!row) waiting.add(path)
      continue
    }
    // The broker reads `mcp.servers` once, as Tade starts (`brokerFor`): a
    // server turned on connects then, and one changed goes on as it was until
    // then. One turned off is off at once (`useServers`), so nothing waits.
    const server = /^mcp\.servers\.([^.]+)$/.exec(path)?.[1]
    if (server !== undefined) {
      if (config.mcp.servers[server]?.enabled === true) waiting.add(path)
      continue
    }
    const name = /^extensions\.([^.]+)\.enabled$/.exec(path)?.[1]
    const one = loaded.find((each) => each.name === name)
    if (one === undefined || one.source === 'mcp' || one.state !== 'off') continue
    if (extensionEnabled(config.extensions[one.name], one.source)) waiting.add(path)
  }
  return waiting
}

/**
 * Each harness's own sign-in, as another machine is told it: whether, until
 * when, and why not — never who as, never a plan, never anything it keeps.
 * A key-paid account is not a sign-in: its key is a setting, carried on a press.
 */
export function signInsOf(views: readonly AccountView[]): SignInHere[] {
  return views
    .filter((one) => one.kind === 'subscription' && one.canSignIn)
    .map((one) => ({
      harness: one.harness,
      account: one.name,
      signedIn: one.status.signedIn,
      until: one.status.until ?? null,
      problem: one.status.problem,
    }))
}
