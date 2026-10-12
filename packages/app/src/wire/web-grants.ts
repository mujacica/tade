import type { Config } from '@tade/core'
import {
  allowDevice,
  type Device,
  GRANTS,
  grantDevice,
  SCOPES,
  surfaceOf,
  type Told,
} from '@tade/web'
import { AWAY_CONTROLS } from '../panels/away/state.ts'
import { type Granted, kept, letOneAct, letOneTalk } from './web-acting.ts'

/**
 * What a device the person lets in may read and do: **everything, and the
 * person takes away what they do not want** — the owner's own decision that
 * the away view should be the whole of Tade by default, opt-out rather than
 * opt-in, so a phone paired on the way out of the door can answer, steer and
 * talk without a second trip to the machine. Two things still hold whatever
 * this says: the asking card says *full access* at the moment of the yes, and
 * the origin's ceiling (`scopesOn`) leaves a device on a plaintext address
 * reading and nothing more. Each chip in the panel takes one back.
 */
export const EVERYTHING = { granted: [...GRANTS], scopes: [...SCOPES] } as const

// The panel's controls that widen what one device may do or read, and
// the one rule they share: **a keypress at this machine is the only door.**
// That holds for the settings too: what a device may change is granted here,
// and there is no setting, route or tool that grants it.
//
// Out of `web.ts` because they are one subject — the window's half of a grant:
// the file, the journal line and the sentence in the strip — and that file is
// the listener's lifetime and the beat. What each one decides is beside the
// fold it writes: `letOneAct` and `letOneTalk` in `web-acting.ts`, the reading
// grant below.
//
// DESIGN.md §9.1's *pairing and scopes are never remote* holds for all three:
// the thing that grants authority is never reachable from inside the
// authority it granted, so there is no route, no orchestrator tool and no
// config key for any of them.

/** What a widening control needs of the away subject. */
export interface Widening {
  home: string
  config(): Config
  now(): number
  /** The devices as the subject holds them now. */
  devices(): readonly Device[]
  log(told: Told): Promise<void>
  news(said: string): void
  reread(): Promise<void>
}

/**
 * Carry out one of the three, by the control's own id — or say it was not one.
 *
 * **Talk is checked before act**, because `away-talk:` and `away-act:` are
 * different prefixes and the order of these branches is the order a reader
 * checks them in; a prefix that is a prefix of another would be a control that
 * silently did the other thing.
 */
export async function widen(deps: Widening, control: string): Promise<boolean> {
  const at = { home: deps.home, now: () => deps.now() }
  if (control.startsWith(AWAY_CONTROLS.talk)) {
    const id = control.slice(AWAY_CONTROLS.talk.length)
    const talking = () => surfaceOf(deps.config().surfaces.web).talking
    const granted = await letOneTalk({ ...at, talking }, deps.devices(), id)
    await written(deps, id, { scopes: granted.scopes.join(' ') }, granted.said)
    return true
  }
  if (control.startsWith(AWAY_CONTROLS.act)) {
    const id = control.slice(AWAY_CONTROLS.act.length)
    const acting = () => surfaceOf(deps.config().surfaces.web).acting
    const granted = await letOneAct({ ...at, acting }, deps.devices(), id)
    await written(deps, id, { scopes: granted.scopes.join(' ') }, granted.said)
    return true
  }
  for (const scope of ['agents', 'projects'] as const) {
    if (!control.startsWith(AWAY_CONTROLS[scope])) continue
    const id = control.slice(AWAY_CONTROLS[scope].length)
    const acting = () => surfaceOf(deps.config().surfaces.web).acting
    const granted = await letOneRun({ ...at, acting }, deps.devices(), id, scope)
    await written(deps, id, { scopes: granted.scopes.join(' ') }, granted.said)
    return true
  }
  if (control.startsWith(AWAY_CONTROLS.configure)) {
    const id = control.slice(AWAY_CONTROLS.configure.length)
    const configuring = () => surfaceOf(deps.config().surfaces.web).configuring
    const granted = await letOneConfigure({ ...at, configuring }, deps.devices(), id)
    await written(deps, id, { scopes: granted.scopes.join(' ') }, granted.said)
    return true
  }
  for (const grant of ['lanes', 'settings'] as const) {
    const prefix = grant === 'lanes' ? AWAY_CONTROLS.see : AWAY_CONTROLS.settings
    if (!control.startsWith(prefix)) continue
    const id = control.slice(prefix.length)
    const granted = await letOneRead(at, deps.devices(), id, grant)
    await written(deps, id, { reads: granted.reads.join(' ') }, granted.said)
    return true
  }
  return false
}

/**
 * The journal line, the sentence and the list read again.
 *
 * `web_paired`, the same kind of line as a device being let in or
 * disconnected, and for the same reason: somebody who did not press the key
 * is the one who most needs to see that it happened.
 */
async function written(
  deps: Widening,
  device: string,
  what: Record<string, string>,
  said: string,
): Promise<void> {
  await deps.log({ type: 'web_paired', detail: { device, ...what, granted: 'at the machine' } })
  deps.news(said)
  await deps.reread()
}

/** What each reading grant with a control lets a device see, in the strip's words. */
export const SEES = {
  lanes: 'see agents’ screens',
  settings: 'read the settings',
} as const

/**
 * Let one device see agents' screens or read the settings, or take it back.
 *
 * **A reading grant and not a scope**, so it is written on a `granted` line
 * rather than an `allowed` one — the two halves of a device's reach are kept
 * apart in the file as they are in the projection. And neither needs a
 * setting: nothing either grants can change anything, and what each lets
 * through is held at the boundary that reads it (`cleanScreen` for a screen,
 * `settingsFor` for the settings, where a key is never in it), whatever any
 * device was granted.
 *
 * **Every other grant is kept as it was**, because `grantDevice` writes the
 * whole list, for the reason `kept` gives about scopes: two controls that each
 * enumerated would be the second silently taking back the first.
 */
export async function letOneRead(
  deps: { home: string; now(): number },
  devices: readonly Device[],
  id: string,
  grant: keyof typeof SEES,
): Promise<{ reads: string[]; said: string }> {
  const device = devices.find((one) => one.id === id && one.revoked === null)
  if (device === undefined) throw new Error('that device is not paired')
  const may = device.granted.includes(grant)
  const others = device.granted.filter((one) => one !== grant)
  const reads = may ? others : [...others, grant]
  await grantDevice(deps.home, id, reads, new Date(deps.now()))
  const what = device.label === '' ? 'that device' : device.label
  return {
    reads,
    said: may ? `${what} can no longer ${SEES[grant]}` : `${what} can ${SEES[grant]}`,
  }
}

/**
 * Let one device change a setting, or take it back. **A person at this
 * machine, only**, through the door `letOneAct` goes through.
 *
 * Composed from what the device already has (`kept`), so granting it takes
 * nothing else away. Refused while `surfaces.web.settings` is off, for
 * `letOneAct`'s reason: a grant nothing could use is what Tade accepting and
 * ignoring a setting would be. It does not grant reading — the `settings` chip
 * beside it does, and a device needs both, because it may not change what it
 * was not allowed to see.
 */
export async function letOneConfigure(
  deps: { home: string; configuring: () => boolean; now: () => number },
  devices: readonly Device[],
  id: string,
): Promise<Granted> {
  if (!deps.configuring()) {
    throw new Error('turn on “Change settings” in Settings → Away view first')
  }
  const device = devices.find((one) => one.id === id && one.revoked === null)
  if (device === undefined) throw new Error('that device is not paired')
  const may = device.scopes.includes('configure')
  const scopes = kept(device, ['configure'], !may)
  await allowDevice(deps.home, id, scopes, new Date(deps.now()))
  const what = device.label === '' ? 'that device' : device.label
  return {
    scopes,
    said: may
      ? `${what} can no longer change a setting`
      : `${what} can change the settings a request is enough for`,
  }
}

/** What each lifecycle scope lets a device do, in the strip's words. */
export const RUNS = {
  agents: 'stop an agent or open it again',
  projects: 'close a project or open it again',
} as const

/**
 * Let one device stop and reopen agents, or close and reopen projects — or
 * take it back. **A person at this machine, only**, through the door
 * `letOneAct` goes through.
 *
 * A scope each, and each composed from what the device already has (`kept`),
 * so granting one takes nothing else away. Refused while acting is off, for
 * `letOneAct`'s reason: these are acting routes, and a grant nothing could use
 * is what Tade accepting and ignoring a setting would be.
 */
export async function letOneRun(
  deps: { home: string; acting: () => boolean; now: () => number },
  devices: readonly Device[],
  id: string,
  scope: keyof typeof RUNS,
): Promise<Granted> {
  if (!deps.acting()) {
    throw new Error('turn on “Act” in Settings → Away view first')
  }
  const device = devices.find((one) => one.id === id && one.revoked === null)
  if (device === undefined) throw new Error('that device is not paired')
  const may = device.scopes.includes(scope)
  const scopes = kept(device, [scope], !may)
  await allowDevice(deps.home, id, scopes, new Date(deps.now()))
  const what = device.label === '' ? 'that device' : device.label
  return {
    scopes,
    said: may ? `${what} can no longer ${RUNS[scope]}` : `${what} can ${RUNS[scope]}`,
  }
}
