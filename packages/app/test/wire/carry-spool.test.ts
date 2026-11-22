import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CARRY_SCHEMA, ConfigSchema, type EventInput, writeSetting } from '@tade/core'
import type { CarryAnswer } from '@tade/remotes-core'
import { recordConfigChanges } from '@tade/workbench/config-changes'
import { EventLog } from '@tade/workbench/events'
import { lockHome } from '@tade/workbench/lock'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { Carries } from '../../src/wire/carry.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Settings } from '../../src/wire/settings.ts'

// A setting set for the first time from a terminal while the window holds the
// journal waits in the spool for the window's beat to write its line down
// (`Settings.fold`). The carry runs on the same beat, and before it folded
// the spool first it could read the file — the value already there — before
// the line, and send the setting with no stamp, which loses to every change
// anywhere however much later it was made. Here the interleaving is forced:
// a beat's fold is held part-way, the terminal writes after that fold has read
// the spool, and the carry starts while it is still held.

const closing: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close()
})

/** Wait until a condition holds, a turn of the loop at a time. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (ok()) return
    await new Promise((done) => setImmediate(done))
  }
  throw new Error(`never: ${what}`)
}

describe('a carry, with a terminal’s change still in the spool', () => {
  it('folds the spool first — waiting out a fold already under way — so the change goes with its stamp', async () => {
    const home = tmp('tade-carry-spool-')
    const configPath = join(home, 'config.yaml')
    writeFileSync(configPath, '')
    // The window holds the home, so a terminal's change waits in the spool.
    const lock = await lockHome(home)
    closing.push(() => lock.release())
    const log = await EventLog.open({
      path: join(home, 'events.jsonl'),
      indexPath: null,
      machine: 'mac',
    })
    closing.push(() => log.close())

    // The beat's fold, held at its first line until the test lets it go.
    let release = () => {}
    const held = new Promise<void>((done) => {
      release = done
    })
    let appends = 0
    const append = async (line: EventInput) => {
      appends++
      if (appends === 1) await held
      return log.append(line)
    }
    let state: AppState = initialState()
    const wire = {
      opts: {
        home,
        config: ConfigSchema.parse({}),
        client: { config: null as unknown, capabilitiesOf: () => null, log: { append } },
        extensions: null,
      },
      get state() {
        return state
      },
      put: (next: AppState) => {
        state = next
      },
      live: null,
      now: () => 1_000,
      openedAt: 0,
      draw: () => {},
      journal: null,
      note: () => {},
    } as unknown as Wiring
    const settings = new Settings(wire, {
      loadAccounts: () => {},
      refreshModels: async () => {},
      lookAtWhatIsInstalled: () => {},
      tellThinking: async () => null,
      setupChanged: () => {},
      openSetup: () => false,
      silence: () => {},
      holdSleep: () => {},
      away: () => ({ follow: () => {}, carry: async () => {} }),
    } as never)

    // The terminal sets one setting; the beat's fold reads the spool and is held.
    writeSetting(configPath, 'queue.holds', 'ask')
    await recordConfigChanges(home, [{ path: 'queue.holds', was: '', now: 'ask', by: 'cli' }])
    const beat = settings.fold()
    await until('the beat’s fold to be under way', () => appends === 1)
    // Then, after that fold read the spool, the terminal sets a second, for the first time.
    writeSetting(configPath, 'notes.keep_days', 9)
    await recordConfigChanges(home, [{ path: 'notes.keep_days', was: '', now: '9', by: 'cli' }])

    // The carry starts now, on the same beat, while the fold is still held.
    const sent: { path: string; hlc?: string }[][] = []
    const answer: CarryAnswer = {
      schema: CARRY_SCHEMA,
      machine: 'vps',
      settings: [],
      files: [],
      signIns: [],
    }
    const carries = new Carries({
      home,
      configPath,
      config: () => ConfigSchema.parse({}),
      reach: () => ({
        link: {
          call: async (
            _remote: unknown,
            _path: string,
            body: { settings: { path: string; hlc?: string }[] },
          ) => {
            sent.push(body.settings)
            return { status: 200, body: answer }
          },
        } as never,
        remote: { name: 'vps' } as never,
        live: true,
      }),
      secrets: () => new Set(),
      from: () => 'mac',
      log: async () => {},
      fold: () => settings.fold(undefined, true),
      lines: () => log.read({ types: ['config_changed'] }),
      found: async () => {},
      take: async () => {},
      conflicted: async () => {},
      onScreenWith: async () => {},
      said: () => {},
      say: () => {},
      draw: () => {},
      now: () => Date.now(),
    })
    const carried = carries.carry('vps', { keys: false })
    release()
    await beat
    await carried
    const leaves = Object.fromEntries((sent[0] ?? []).map((one) => [one.path, one]))
    expect(leaves['queue.holds']?.hlc).toMatch(/^\d+:\d+:mac$/)
    expect(leaves['notes.keep_days']?.hlc).toMatch(/^\d+:\d+:mac$/)
  })
})
