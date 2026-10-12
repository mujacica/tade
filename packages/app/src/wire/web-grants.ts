import type { Config } from '@tade/core'
import { type Device, grantDevice, surfaceOf, type Told } from '@tade/web'
import { AWAY_CONTROLS } from '../panels/away/state.ts'
import { letOneAct, letOneTalk } from './web-acting.ts'

// The panel's three controls that widen what one device may do or read, and
// the one rule they share: **a keypress at this machine is the only door.**
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
  if (control.startsWith(AWAY_CONTROLS.see)) {
    const id = control.slice(AWAY_CONTROLS.see.length)
    const granted = await letOneSee(at, deps.devices(), id)
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

/**
 * Let one device see agents' screens, or take it back.
 *
 * **A reading grant and not a scope**, so it is written on a `granted` line
 * rather than an `allowed` one — the two halves of a device's reach are kept
 * apart in the file as they are in the projection. And it needs no setting:
 * nothing it grants can change anything, and what it lets through is held at
 * the boundary that reads a screen (`cleanScreen`), whatever any device was
 * granted.
 *
 * **Every other grant is kept as it was**, because `grantDevice` writes the
 * whole list, for the reason `kept` gives about scopes: two controls that each
 * enumerated would be the second silently taking back the first.
 */
export async function letOneSee(
  deps: { home: string; now(): number },
  devices: readonly Device[],
  id: string,
): Promise<{ reads: string[]; said: string }> {
  const device = devices.find((one) => one.id === id && one.revoked === null)
  if (device === undefined) throw new Error('that device is not paired')
  const may = device.granted.includes('lanes')
  const reads = may
    ? device.granted.filter((one) => one !== 'lanes')
    : [...device.granted.filter((one) => one !== 'lanes'), 'lanes']
  await grantDevice(deps.home, id, reads, new Date(deps.now()))
  const what = device.label === '' ? 'that device' : device.label
  return {
    reads,
    said: may ? `${what} can no longer see agents’ screens` : `${what} can see agents’ screens`,
  }
}
