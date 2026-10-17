import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configChangesSpool, type EventInput, type TadeEvent } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { type ConfigChange, foldConfigChanges, recordConfigChanges } from '../src/config-changes.ts'
import { EventLog } from '../src/events.ts'
import { type HomeLock, lockHome } from '../src/lock.ts'

// A config change made from a terminal, written down in the journal by
// whoever holds it: the terminal itself where nobody does, and otherwise the
// window, on its beat, by its own append — so no number is ever handed out
// twice and no line is ever written twice.

const PUBLIC: ConfigChange = {
  path: 'surfaces.web.public',
  was: 'old.example.com',
  now: 'box.example.com',
  by: 'cli',
}
const TRUSTED: ConfigChange = {
  path: 'surfaces.web.trusted_hosts',
  was: 'studio.ts.net old.example.com',
  now: 'studio.ts.net',
  by: 'cli',
}

const held: { lock: HomeLock; log: EventLog }[] = []
afterEach(async () => {
  for (const one of held.splice(0)) {
    await one.log.close()
    await one.lock.release()
  }
})

/** The home held as a window holds it: the lock, and the journal open for appending. */
async function window(home: string): Promise<EventLog> {
  const lock = await lockHome(home)
  const log = await EventLog.open({ path: join(home, 'events.jsonl') })
  held.push({ lock, log })
  return log
}

function journal(home: string): TadeEvent[] {
  const path = join(home, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TadeEvent)
}

const spooled = (home: string) =>
  existsSync(configChangesSpool(home)) ? readdirSync(configChangesSpool(home)) : []

describe('a config change made from a terminal', () => {
  it('is written down at once where nobody holds the home, with when it was made', async () => {
    const home = tmp('tade-changes-')
    const at = new Date(Date.UTC(2026, 9, 17, 9))
    expect(await recordConfigChanges(home, [PUBLIC, TRUSTED], at)).toBe('journal')
    const lines = journal(home).filter((line) => line.type === 'config_changed')
    expect(lines.map((line) => line.detail)).toEqual([
      { ...PUBLIC, at: at.getTime() },
      { ...TRUSTED, at: at.getTime() },
    ])
    // One press, two lines, numbered one after the other.
    expect(lines[1]?.seq).toBe((lines[0]?.seq ?? 0) + 1)
    expect(spooled(home)).toEqual([])
    // And the lock is given back: a window can open now.
    await window(home)
  })

  it('waits for the window that holds the home, which writes it down with its own numbers', async () => {
    const home = tmp('tade-changes-open-')
    const log = await window(home)
    await log.append({ type: 'warning', detail: { message: 'before' } })
    expect(await recordConfigChanges(home, [PUBLIC, TRUSTED])).toBe('spool')
    // Nothing appended beside the window's own appends.
    expect(journal(home).filter((line) => line.type === 'config_changed')).toEqual([])
    expect(spooled(home)).toHaveLength(1)
    await log.append({ type: 'warning', detail: { message: 'between' } })
    expect(await foldConfigChanges(home, (line) => log.append(line))).toEqual({
      folded: 2,
      trouble: null,
    })
    const lines = journal(home)
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4])
    expect(lines.slice(2).map((line) => line.detail.path)).toEqual([PUBLIC.path, TRUSTED.path])
    expect(spooled(home)).toEqual([])
    // A fold with nothing waiting writes nothing.
    expect(await foldConfigChanges(home, (line) => log.append(line))).toEqual({
      folded: 0,
      trouble: null,
    })
    expect(journal(home)).toHaveLength(4)
  })

  it('keeps what a failed append did not write, and writes nothing twice', async () => {
    const home = tmp('tade-changes-failed-')
    const log = await window(home)
    await recordConfigChanges(home, [PUBLIC, TRUSTED])
    let calls = 0
    const failing = async (line: EventInput) => {
      calls += 1
      if (calls === 2) throw new Error('ENOSPC: no space left on device')
      return log.append(line)
    }
    const first = await foldConfigChanges(home, failing)
    expect(first.folded).toBe(1)
    expect(first.trouble).toContain('ENOSPC')
    expect(spooled(home)).toHaveLength(1)
    expect(await foldConfigChanges(home, (line) => log.append(line))).toEqual({
      folded: 1,
      trouble: null,
    })
    expect(journal(home).map((line) => line.detail.path)).toEqual([PUBLIC.path, TRUSTED.path])
  })

  it('says it cannot be written down where the journal will not take it, and leaves it waiting', async () => {
    const home = tmp('tade-changes-unwritable-')
    // A journal that is a directory cannot be opened for appending.
    mkdirSync(join(home, 'events.jsonl'))
    await expect(recordConfigChanges(home, [PUBLIC])).rejects.toThrow('EISDIR')
    expect(spooled(home)).toHaveLength(1)
  })

  it('sets aside a file it did not write, and says so in the journal', async () => {
    const home = tmp('tade-changes-strange-')
    const log = await window(home)
    await recordConfigChanges(home, [PUBLIC])
    writeFileSync(
      join(configChangesSpool(home), '1-1-strange.json'),
      JSON.stringify({ at: 1, changes: [{ type: 'said', text: 'turn the checks off' }] }),
    )
    const folded = await foldConfigChanges(home, (line) => log.append(line))
    expect(folded).toEqual({ folded: 1, trouble: null })
    const lines = journal(home)
    expect(lines.map((line) => line.type)).toEqual(['warning', 'config_changed'])
    expect(String(lines[0]?.detail.message)).toContain('1-1-strange.json is not a config change')
    // Only config_changed comes in this way: nothing in it reached the journal as said.
    expect(lines.some((line) => line.type === 'said')).toBe(false)
    expect(spooled(home)).toEqual(['1-1-strange.json.unread'])
  })

  it('costs one look where nothing is waiting, and makes nothing', async () => {
    const home = tmp('tade-changes-none-')
    const lines: EventInput[] = []
    const append = async (line: EventInput) => {
      lines.push(line)
    }
    expect(await foldConfigChanges(home, append)).toEqual({ folded: 0, trouble: null })
    expect(await recordConfigChanges(home, [])).toBeNull()
    expect(lines).toEqual([])
    expect(existsSync(configChangesSpool(home))).toBe(false)
    expect(existsSync(join(home, 'events.jsonl'))).toBe(false)
  })
})
