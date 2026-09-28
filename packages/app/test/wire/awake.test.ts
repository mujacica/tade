import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAFFEINATE, type Config, ConfigSchema, NO_HOLD_HERE } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { Awake, caffeineHold, type Hold } from '../../src/wire/awake.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The anti-sleep hold, and the button that takes it.
//
// Given its own hold rather than the machine's, for the reason the waker is
// given its own clock: a test may not ask the laptop the suite is running on
// to stay awake, and could not assert anything about it afterwards if it did.
// What is under test is the bookkeeping — that the assertion follows the
// setting, that it is dropped exactly once, and that a machine with nothing to
// hold it with says so instead of pretending.

/** A hold that counts rather than holding: what was taken, and what was dropped. */
function scripted(over: { program?: string | null; fails?: string } = {}) {
  const took: string[] = []
  let dropped = 0
  const hold: Hold = {
    program: () => (over.program === undefined ? '/usr/bin/caffeinate' : over.program),
    start: (program) => {
      if (over.fails) throw new Error(over.fails)
      took.push(program)
      return () => {
        dropped += 1
      }
    },
  }
  return { hold, took, dropped: () => dropped }
}

/** A window with one config in it, and the setting written the way the one door writes it. */
function windowWith(keep: boolean, over: { refuses?: string } = {}) {
  let config: Config = ConfigSchema.parse({ agents: { keep_awake: keep } })
  let state: AppState = initialState()
  const wrote: boolean[] = []
  const wire = {
    opts: {
      get config() {
        return config
      },
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
  } as unknown as Wiring
  return {
    wire,
    wrote,
    said: () => state.notice,
    /**
     * The one door a setting is written by, as the window wires it: it writes
     * the config and hands it back to everywhere that holds one — which is
     * what calls `apply`. A refusal throws, exactly as `writeKey` does.
     */
    keep: (awake: Awake) => async (on: boolean) => {
      if (over.refuses) throw new Error(over.refuses)
      wrote.push(on)
      config = ConfigSchema.parse({ agents: { keep_awake: on } })
      awake.apply()
    },
  }
}

/** An `Awake` over that window, with a hold that counts. */
function held(keep: boolean, hold: Hold, over: { refuses?: string } = {}) {
  const win = windowWith(keep, over)
  const awake: Awake = new Awake(win.wire, { keep: (on) => win.keep(awake)(on) }, hold)
  return { ...win, awake }
}

describe('holding the machine awake', () => {
  it('takes nothing at all until somebody has asked for it', () => {
    // Off is the default and the hold is the machine's power state: a window
    // opening must never be a laptop that stops sleeping.
    const { hold, took } = scripted()
    const { awake } = held(false, hold)
    awake.apply()
    expect(took).toEqual([])
    expect(awake.facts().awake).toEqual({ held: false, problem: null })
  })

  it('takes it when the config says so, and reports it as held', () => {
    const { hold, took } = scripted()
    const { awake } = held(true, hold)
    awake.apply()
    expect(took).toEqual(['/usr/bin/caffeinate'])
    expect(awake.facts().awake).toEqual({ held: true, problem: null })
  })

  it('takes it once however many times the config changes', () => {
    // `apply` runs on every config change and not only the ones about sleep,
    // so applying what is already true has to be nothing at all — otherwise
    // editing an unrelated setting starts a second caffeinate.
    const { hold, took } = scripted()
    const { awake } = held(true, hold)
    awake.apply()
    awake.apply()
    awake.apply()
    expect(took).toHaveLength(1)
  })

  it('drops it when the window stops, and stays dropped if asked twice', () => {
    const { hold, dropped } = scripted()
    const { awake } = held(true, hold)
    awake.apply()
    awake.release()
    awake.release()
    expect(dropped()).toBe(1)
    expect(awake.facts().awake?.held).toBe(false)
  })

  it('drops it when somebody turns it off, and takes a new one when they turn it back on', async () => {
    const { hold, took, dropped } = scripted()
    const { awake, wrote } = held(true, hold)
    awake.apply()
    await awake.actions().awake?.('')
    expect(wrote).toEqual([false])
    expect(dropped()).toBe(1)
    expect(awake.facts().awake?.held).toBe(false)
    await awake.actions().awake?.('')
    expect(wrote).toEqual([false, true])
    expect(took).toHaveLength(2)
    expect(awake.facts().awake?.held).toBe(true)
  })
})

describe('what the button says', () => {
  it('says what it changed, in the terms it changed it', async () => {
    const { hold } = scripted()
    const { awake, said } = held(false, hold)
    await awake.actions().awake?.('')
    expect(said()).toContain('stays awake while Tade is open')
    await awake.actions().awake?.('')
    expect(said()).toContain('carry on when the machine wakes')
  })

  it('says what is missing rather than pretending, where there is nothing to hold it with', async () => {
    // Linux, or a mac stripped of it. Nothing is written — a setting Tade
    // accepts and ignores is worse than one it does not have — and the
    // sentence carries the other half, which is still true.
    const { hold, took } = scripted({ program: null })
    const { awake, wrote, said } = held(false, hold)
    awake.apply()
    await awake.actions().awake?.('')
    expect(wrote).toEqual([])
    expect(took).toEqual([])
    expect(said()).toBe(NO_HOLD_HERE)
    expect(awake.facts().awake).toEqual({ held: false, problem: NO_HOLD_HERE })
  })

  it('says why when the hold could not be taken, rather than reporting it held', async () => {
    // The setting was written, so the config says yes; the machine says no.
    // What is drawn is what came of it, never what was asked for.
    const { hold } = scripted({ fails: 'caffeinate: Operation not permitted' })
    const { awake, said } = held(false, hold)
    await awake.actions().awake?.('')
    expect(awake.facts().awake?.held).toBe(false)
    expect(awake.facts().awake?.problem).toContain('Operation not permitted')
    expect(said()).toContain('Operation not permitted')
  })

  it('says why when the setting could not be written, and holds nothing', async () => {
    const { hold, took } = scripted()
    const { awake, said } = held(false, hold, { refuses: 'config.yaml is not writable' })
    await awake.actions().awake?.('')
    expect(took).toEqual([])
    expect(said()).toContain('not writable')
    expect(awake.facts().awake?.held).toBe(false)
  })
})

describe('the hold this machine would actually take', () => {
  it('is whatever PATH answers to, and null where nothing does', () => {
    // Looked for rather than decided by platform: the question is whether the
    // program is here. A directory that is not there is the Linux answer.
    const dir = tmp('tade-awake-')
    const program = join(dir, CAFFEINATE)
    writeFileSync(program, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(caffeineHold({ PATH: dir }).program()).toBe(program)
    expect(caffeineHold({ PATH: join(dir, 'nowhere') }).program()).toBeNull()
    expect(caffeineHold({}).program()).toBeNull()
  })

  it('does not take the window down when the spawn fails after all', async () => {
    // A spawn fails asynchronously, and an unhandled `error` on a child ends
    // the process it is in — which here is the whole window, over a laptop
    // that will now sleep. Dropping one that never started is the same case.
    const drop = caffeineHold().start(join(tmp('tade-awake-'), 'not-here'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => drop()).not.toThrow()
    expect(() => drop()).not.toThrow()
  })
})
