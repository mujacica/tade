import {
  parseSetting,
  type Setting,
  type SettingGroup,
  settingReach,
  wantedInstead,
} from '@tade/core'
import {
  byOf,
  clearOnly,
  type Device,
  type From,
  keysOf,
  Moved,
  NotOffered,
  NotThere,
  type Outcome,
  OutOfScope,
  projectOfSetting,
  type SettingCall,
  settingOut,
  type WebConfiguring,
} from '@tade/web'

// The window's end of changing a setting from away: what one change actually
// does.
//
// **Its own file, and the seam is the one `web-drafting.ts` has.** What the
// away view is handed is exactly this — `change` and `unlocked`, and nothing
// else on it. Handing it the `Settings` subject would put `writeKey`, the
// accounts and the extension host one property access away from a route.
//
// ## The four things only the window can do, and this file owes all four
//
// 1. **Re-check who is asking, at the write.** The device record *now* — still
//    paired, still granted `configure` and the `settings` reading grant, and
//    still reading the project a setting belongs to — not the session the
//    request arrived on. A grant taken back at the panel a second ago counts.
// 2. **Re-check how far a device reaches.** `settingReach` asked again, so a
//    path that was `open` when the listener started and is not now is refused
//    — the tier is core's decision and this costs one call.
// 3. **Re-check the value against the row the window lists now**, through the
//    same `settingOut` the reading was built with: the write accepts exactly
//    what the read offered, a key is only ever cleared, and a change from a
//    screen drawn before somebody else's meets a value that has moved.
// 4. **Write through the one door every setting goes through** —
//    `Settings.write`, which puts a refused value back, hands the new config to
//    everything that holds one and writes `config_changed` — with `by` as the
//    device (`byOf`), never `window` and never `you`.
//
// **One change at a time.** The checks and the write's own first, synchronous
// half run with no `await` between them, so nothing else in the window can
// write between the look and the write; the chain below keeps a second change
// from away from starting until the first is answered. What it cannot see is
// somebody editing `config.yaml` by hand behind the window's back — which the
// Settings page cannot see either, and is the honest limit of both.

/** What changing a setting needs of the window. */
export interface ConfiguringDeps {
  /** Whether `surfaces.web.settings` is on, read **at the change**. */
  configuring: () => boolean
  /** The devices as they are now, so a grant narrowed a second ago counts. */
  devices: () => readonly Device[]
  /** The settings as the Settings page lists them now. */
  rows: () => readonly SettingGroup[]
  /** Every key the window knows of, which a shown value is cleaned of. */
  known: () => readonly string[]
  /** The one door: write, read back, use, and record with `by`. Throws on a refusal. */
  write: (path: string, value: string, by: string) => Promise<string>
}

/**
 * The one method, and nothing else reachable.
 *
 * `unlocked` is read at every change: the route table was built when the
 * window started, so turning the setting **off** has to mean something before
 * the next restart.
 */
export function webConfiguring(deps: ConfiguringDeps): WebConfiguring {
  let going: Promise<unknown> = Promise.resolve()
  return {
    unlocked: () => deps.configuring(),
    change(call: SettingCall, from: From): Promise<Outcome> {
      const run = going.then(() => changeOne(deps, call, from))
      going = run.catch(() => {})
      return run
    },
  }
}

async function changeOne(deps: ConfiguringDeps, call: SettingCall, from: From): Promise<Outcome> {
  const device = deviceOf(deps, from)
  const project = projectOfSetting(call.path)
  if (project !== null && device.projects !== null && !device.projects.includes(project)) {
    throw new OutOfScope(`${byOf(from)} does not read ${project}`)
  }
  // **The tier, asked of core again.** The parse already refused anything that
  // is not `open`; this is the window not taking that on trust.
  if (settingReach(call.path).reach !== 'open') {
    throw new NotOffered(`${call.path} is changed at this machine`)
  }
  const groups = deps.rows()
  const found = findIn(groups, call.path)
  if (found === null) throw new NotThere(`Tade has no setting called ${call.path}`)
  const { group, setting } = found
  const row = settingOut(group, setting, project, keysOf(groups, deps.known()))
  if (row.may !== 'change' || row.was === null) throw new NotOffered(row.why)
  if (row.was !== call.was) {
    // What is true now goes back with the refusal — the value as a device
    // granted `settings` may read it, or for a key whether one is held — so
    // the page redraws the truth and whatever was typed stays typed.
    throw new Moved(`${setting.title} has changed since this screen was drawn`, row.was)
  }
  // **A key is only ever cleared.** A device was never shown it, so it can
  // never have meant to set one — and the `set` it was shown must never be
  // round-tripped into the file where the key was.
  if (clearOnly(group, setting) && call.value !== '') {
    throw new NotOffered(`${setting.title} can only be cleared from away`)
  }
  // **What the value may be, asked before the write rather than after**, and
  // stricter than the page's own reading of a typed value: `parseSetting` takes
  // a choice as typed (the schema refuses it on the read back, after a write
  // and a put-back) and reads any word but *yes* as `false` for a flag — fine
  // for somebody at a keyboard, and not what a device's exact value means.
  if (call.value !== '' && !exactly(setting, call.value)) {
    throw new NotOffered(`${setting.title} needs ${wantedInstead(setting)}`)
  }
  if (call.value === setting.value) {
    return { did: false, rev: row.was, said: `${setting.title} was already that` }
  }
  // **A write that fails now is not a refusal.** Every reason a value could be
  // refused was asked above, so a throw here is the machine — a file that
  // would not load, a disk — and it goes up as it is: the door puts the file
  // back, the device is told something went wrong here, and the detail is a
  // `warning` the person at the machine can read rather than a `404` saying
  // there was nothing by that name.
  const told = await deps.write(call.path, call.value, byOf(from))
  const after = findIn(deps.rows(), call.path)
  const now =
    after === null
      ? ''
      : (settingOut(after.group, after.setting, project, keysOf(deps.rows(), deps.known())).was ??
        '')
  return { did: true, rev: now, said: `${setting.title}: ${told}` }
}

/**
 * The device this change is from, as the record says **now**.
 *
 * A local `from` cannot reach here — the keyboard's door is the Settings page,
 * which never goes through a `WebConfiguring` — and is refused rather than
 * quietly allowed, because the one thing that must never happen is a change
 * from away recorded as the person's own.
 */
function deviceOf(deps: ConfiguringDeps, from: From): Device {
  if (from.how !== 'remote') {
    throw new OutOfScope('a change from away is never the person at the machine')
  }
  const device = deps.devices().find((one) => one.id === from.device && one.revoked === null)
  if (device === undefined) throw new OutOfScope('that device is not paired')
  if (!device.scopes.includes('configure')) {
    throw new OutOfScope(`${byOf(from)} was not granted changing settings`)
  }
  if (!device.granted.includes('settings')) {
    throw new OutOfScope(`${byOf(from)} was not granted reading settings`)
  }
  return device
}

/** Whether a value from away is one this setting takes, exactly as sent. */
function exactly(setting: Setting, value: string): boolean {
  if (value !== value.trim()) return false
  if (setting.type.kind === 'choice') return setting.type.options.includes(value)
  if (setting.type.kind === 'flag') return value === 'true' || value === 'false'
  return parseSetting(setting, value) !== undefined
}

function findIn(
  groups: readonly SettingGroup[],
  path: string,
): { group: SettingGroup; setting: Setting } | null {
  for (const group of groups) {
    const setting = group.settings.find((one) => one.path === path)
    if (setting !== undefined) return { group, setting }
  }
  return null
}
