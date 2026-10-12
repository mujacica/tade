import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lastUpdates, rememberUpdates, UPDATES_FILE, type UpdateLook } from '../src/programs.ts'

// The last answer about what is current, kept in Tade's home so a window that
// opens knows what the last one found without asking the network again.
//
// What is held is the one rule a cache like this can break quietly: **only an
// answer that asked is kept**, and anything that is not one reads back as
// nobody having asked — never as an empty answer, which the strip would draw
// as everything being current.

const home = () => mkdtempSync(join(tmpdir(), 'tade-kept-'))

const look = (asked: boolean): UpdateLook => ({
  at: 1_000,
  asked,
  tade: {
    version: '0.1.0',
    from: 'checkout',
    where: '/src/tade',
    branch: 'main',
    commit: 'f8d73e1',
    install: null,
    newer: 'origin/main is at 1a2b3c4',
    cannotTell: null,
    update: { command: 'git -C /src/tade pull --ff-only' },
  },
  programs: [],
})

describe('the last answer about what is current', () => {
  it('reads back what was kept', async () => {
    const at = home()
    await rememberUpdates(at, look(true))
    expect(await lastUpdates(at)).toEqual(look(true))
    // Written aside and moved over: nothing half-written is ever left beside it.
    expect(readdirSync(at)).toEqual([UPDATES_FILE])
  })

  it('keeps nothing that never asked', async () => {
    const at = home()
    await rememberUpdates(at, look(false))
    expect(await lastUpdates(at)).toBeNull()
  })

  it('reads nothing, a broken file and an older shape alike as nobody having asked', async () => {
    const at = home()
    expect(await lastUpdates(at)).toBeNull()
    writeFileSync(join(at, UPDATES_FILE), '{"at": 1')
    expect(await lastUpdates(at)).toBeNull()
    writeFileSync(join(at, UPDATES_FILE), JSON.stringify({ at: 1, asked: true, programs: [] }))
    expect(await lastUpdates(at)).toBeNull()
  })
})
