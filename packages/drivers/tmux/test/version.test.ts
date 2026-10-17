import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { availableAs, OLDEST } from '../src/attach.ts'
import { TmuxDriver } from '../src/index.ts'

// The oldest tmux the driver works on, said where setting up asks: a terminal
// shown a lane needs `run-shell -C` (3.2), and on 3.1c and 3.0a the whole
// attach failed with tmux's own usage line in the tab while setup said all was
// well. What the conformance suite does on each was measured on tmux built in
// a `node:22` container (`attach.ts` says what).

describe('which tmux can hold lanes', () => {
  const cases: [string, string | null, boolean][] = [
    ['Ubuntu 20.04’s', 'tmux 3.0a\n', false],
    ['Debian 11’s', 'tmux 3.1c\n', false],
    ['one with no send-keys -H', 'tmux 2.9a\n', false],
    ['the first with run-shell -C', 'tmux 3.2\n', true],
    ['Ubuntu 22.04’s', 'tmux 3.2a\n', true],
    ['Ubuntu 24.04’s', 'tmux 3.4\n', true],
    ['a release candidate', 'tmux next-3.6\n', true],
    // Built from a branch: nobody can tell it is too old, so it is not said to be.
    ['one that names no version', 'tmux master\n', true],
  ]
  for (const [what, said, ok] of cases) {
    it(`${what}: ${ok ? 'yes' : 'no'}`, () => {
      expect(availableAs(said).ok).toBe(ok)
    })
  }

  it('says what is here, what is needed, and how to get it', () => {
    expect(availableAs('tmux 3.1c\n')).toEqual({
      ok: false,
      reason: `tmux 3.1c is older than ${OLDEST}, the first that can show a lane in a terminal of its own (brew install tmux, or the tmux of Ubuntu 22.04, Debian 12 or later)`,
    })
  })

  it('says a tmux that never answered is not installed', () => {
    expect(availableAs(null)).toEqual({
      ok: false,
      reason: 'tmux is not installed (brew install tmux)',
    })
  })
})

describe('the driver asks the tmux it would run', () => {
  const drivers: TmuxDriver[] = []
  afterEach(async () => {
    for (const driver of drivers.splice(0)) await driver.detach()
  })
  /** A driver whose PATH has only `bin` on it. */
  const on = (bin: string) => {
    const driver = new TmuxDriver({ socket: `tade-version-${process.pid}`, env: { PATH: bin } })
    drivers.push(driver)
    return driver
  }

  it('and refuses one older than it works on, in its own words', async () => {
    const bin = tmp('tade-tmux-old-')
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho "tmux 3.1c"\n')
    chmodSync(join(bin, 'tmux'), 0o755)
    const can = await on(bin).available()
    expect(can.ok).toBe(false)
    expect(can.ok ? '' : can.reason).toMatch(/^tmux 3\.1c is older than 3\.2, /)
  })

  it('and says so where there is none', async () => {
    expect(await on(tmp('tade-tmux-none-')).available()).toEqual({
      ok: false,
      reason: 'tmux is not installed (brew install tmux)',
    })
  })
})
