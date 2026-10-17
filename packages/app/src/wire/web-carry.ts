import {
  type Config,
  carriedSays,
  extensionEnabled,
  machineLabel,
  type SettingGroup,
  writtenAt,
} from '@tade/core'
import type { LoadedExtension } from '@tade/extensions-core'
import { carryingAt, inTime, type SignInHere, type WebCarrying } from '@tade/web'
import type { AccountView } from '@tade/workbench/accounts'
import { configPathOf, type Wiring } from './context.ts'
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
      await settings.writeKey(path, value as Parameters<Settings['writeKey']>[1], was, {
        by: `device ${by.device}`,
        now: carriedSays(carry, value),
        carried: by.from,
      })
      // An extension's own setting means nothing until the extension has it,
      // as from the Settings page; which extensions are on still waits for the
      // next start, as it does wherever it is changed.
      if (path.startsWith('extensions.')) {
        await wire.opts.extensions?.reconfigure(wire.opts.config.extensions)
      }
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
      waitingHere(
        paths,
        settings.rows(),
        wire.opts.config.extensions,
        wire.opts.extensions?.list() ?? [],
      ),
  })
  return carrying
}

/**
 * Of these paths, the ones a change to waits for Tade to start again here: a
 * row Settings says is not live — what it says where somebody changes one here
 * — and an extension that is on and not running, one of yours, which is never
 * imported mid-session.
 */
export function waitingHere(
  paths: readonly string[],
  rows: readonly SettingGroup[],
  extensions: Config['extensions'],
  loaded: readonly Pick<LoadedExtension, 'name' | 'source' | 'state'>[],
): Set<string> {
  const live = new Map(rows.flatMap((group) => group.settings).map((one) => [one.path, one.live]))
  const waiting = new Set<string>()
  for (const path of paths) {
    const row = live.get(path)
    if (row !== undefined) {
      if (!row) waiting.add(path)
      continue
    }
    const name = /^extensions\.([^.]+)\.enabled$/.exec(path)?.[1]
    const one = loaded.find((each) => each.name === name)
    if (one === undefined || one.source === 'mcp' || one.state !== 'off') continue
    if (extensionEnabled(extensions[one.name], one.source)) waiting.add(path)
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
