import { join } from 'node:path'
import { writeSetting } from '@tade/core'
import type { Wiring } from '../../src/wire/context.ts'
import { Settings, type SettingsDeps } from '../../src/wire/settings.ts'
import type { AwayDeps } from '../../src/wire/web.ts'

// The settings half of the away harness: the window's own `Settings` subject
// behind the away view, and the home's file it writes.
//
// **Its own file for the reason `away-lifecycle.ts` is**: a different subject,
// and the harness at the length a file is allowed to be.
//
// **The door is the real one.** A change from away goes through
// `Settings.write`, which writes the home's `config.yaml`, reads it back, hands
// the new config to the window and writes `config_changed` — a stand-in that
// answered *saved* would be the kindest fixture there is for the one write this
// surface can make.

/**
 * What the Settings subject asks of the rest of the window, and nothing of it
 * here: no accounts, no models, no microphone. A change from away reaches none
 * of them — the open tier is two sizes, an editor and a push mode.
 */
const NOTHING_ELSE: SettingsDeps = {
  loadAccounts: () => {},
  refreshModels: () => Promise.resolve(),
  lookAtWhatIsInstalled: () => {},
  tellThinking: () => Promise.resolve(null),
  setupChanged: () => {},
  silence: () => {},
  accountAction: () => Promise.resolve(),
  updateAction: () => Promise.resolve(),
  testMicrophone: () => Promise.resolve(),
  openFile: () => Promise.resolve(),
  copy: () => Promise.resolve(false),
  releases: () => false,
  holdSleep: () => {},
}

/**
 * The window's settings, as the away subject is handed them.
 *
 * `writeKey` is the harness's own, and deliberately **not** `Settings.writeKey`:
 * the notification tests depend on a key written to the file and not handed to
 * the window, which is the direction that makes such a test fail rather than
 * pass (`away-harness.ts` has the argument).
 */
export function settingsDoor(wire: Wiring, writeKey: AwayDeps['settings']['writeKey']) {
  const door = new Settings(wire, NOTHING_ELSE)
  return {
    rows: () => door.rows(),
    write: (path: string, value: string, by?: string) => door.write(path, value, by),
    writeKey,
  }
}

/**
 * Changing a setting from away on, in the home's own file.
 *
 * **Both configs**, for `intake`'s reason: the window's in-memory config is
 * what the capability is read from, and `Settings.write` reads the file back
 * after every change — so a file that did not say the same would turn the
 * capability off under the test at its first write.
 */
export function settingsOn(home: string, port: number, acting: boolean): void {
  for (const [key, value] of [
    ['surfaces.web.enabled', true],
    ['surfaces.web.port', port],
    ['surfaces.web.acting', acting],
    ['surfaces.web.settings', true],
  ] as const) {
    writeSetting(join(home, 'config.yaml'), key, value)
  }
}
