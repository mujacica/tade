import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Memory } from '../src/memory.ts'
import { cleanupNotes } from '../src/notes.ts'
import { Workbench } from '../src/workbench.ts'

// Notes look after themselves: the same words are one note however often they
// arrive, and what has stopped mattering is retired — still in the file and
// still read on asking, never told to anybody again.

const DAY = 86_400_000
const NOW = Date.parse('2026-10-16T09:00:00Z')

const lines = (home: string) =>
  readFileSync(join(home, 'memory.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('the same words twice', () => {
  it('are one note, and the second time says so and writes nothing', () => {
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    const first = memory.remember('figure out mobile too', 'tade/away-docks', 'orchestrator', NOW)
    const again = memory.remember(
      'figure out mobile too',
      'tade/away-docks',
      'orchestrator',
      NOW + 1,
    )
    expect(first.already).toBeUndefined()
    expect(again.already).toBe('noted')
    expect(again.at).toBe(first.at)
    expect(lines(home)).toHaveLength(1)
  })

  it('about three tasks at once are one note about three, after a restart too', () => {
    // The shape on the machine this was written on: one sentence, three
    // parallel tool calls in one turn, three rows of the same words.
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    const said = 'no remote terminal access'
    memory.remember(said, 'tade/away-desktop', 'orchestrator', NOW)
    const second = memory.remember(said, 'tade/away-verbs', 'orchestrator', NOW + 1)
    const third = memory.remember(said, 'tade/away-settings', 'orchestrator', NOW + 2)
    expect(second.already).toBe('widened')
    expect(third.already).toBe('widened')

    const kept = Memory.open(home).all()
    expect(kept).toHaveLength(1)
    expect(kept[0]?.scope).toBe('tade/away-desktop')
    expect(kept[0]?.also).toEqual(['tade/away-verbs', 'tade/away-settings'])
    expect(
      Memory.open(home)
        .recall('tade/away-settings')
        .map((n) => n.text),
    ).toEqual([said])
    // The words once; the rest are lines about that note.
    expect(lines(home).filter((line) => line.text === said)).toHaveLength(1)
  })

  it('about everything, after a note about one task, make that one note about everything', () => {
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    memory.remember('pin major versions', 'tade/deps', 'cli', NOW)
    expect(memory.remember('pin major versions', null, 'cli', NOW + 1).already).toBe('widened')
    expect(Memory.open(home).all()[0]?.scope).toBeNull()
    expect(
      Memory.open(home)
        .recall('cruxed/web')
        .map((n) => n.text),
    ).toEqual(['pin major versions'])
  })

  it('are already noted under a note about everything, and the answer says where', () => {
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    memory.remember('route AI through OpenRouter', null, 'orchestrator', NOW)
    const again = memory.remember('route AI through OpenRouter', 'zz/c3', 'orchestrator', NOW + 1)
    expect(again.already).toBe('noted')
    expect(again.scope).toBeNull()
    expect(lines(home)).toHaveLength(1)
  })

  it('are found when another process wrote the first, as `tade remember` does', () => {
    const home = tmp('tade-notes-')
    const window = Memory.open(home)
    Memory.open(home).remember('freeze on Fridays', 'tade', 'cli', NOW)
    expect(window.remember('freeze on Fridays', 'tade', 'window', NOW + 1).already).toBe('noted')
  })

  it('are a new note when the one they were is retired', () => {
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    const first = memory.remember('freeze on Fridays', 'tade', 'cli', NOW)
    memory.retire({ at: first.at }, 'they lifted the freeze', 'window', NOW + 1)
    const again = memory.remember('freeze on Fridays', 'tade', 'cli', NOW + 2)
    expect(again.already).toBeUndefined()
    expect(memory.recall('tade').map((n) => n.at)).toEqual([again.at])
  })
})

describe('retiring a note', () => {
  it('takes it out of what anybody is told and keeps it to read, with why', () => {
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    const kept = memory.remember('use the ledger', 'app/refunds', 'orchestrator', NOW)
    const gone = memory.remember('pause the queue', 'app', 'orchestrator', NOW + 1)
    memory.retire({ at: gone.at }, 'they said to let the queue run', 'orchestrator', NOW + 2)

    const reopened = Memory.open(home)
    expect(reopened.recall('app/refunds').map((n) => n.text)).toEqual([kept.text])
    expect(reopened.all().map((n) => n.text)).toEqual([kept.text])
    const all = reopened.all({ retired: true })
    expect(all.map((n) => n.text)).toEqual([gone.text, kept.text])
    expect(all[0]?.retired).toEqual({
      by: 'orchestrator',
      at: new Date(NOW + 2).toISOString(),
      because: 'they said to let the queue run',
    })
    // Nothing rewritten: the words are still where they were written.
    expect(lines(home)[1]).toMatchObject({ text: 'pause the queue', scope: 'app' })
  })

  it('refuses rather than guesses', () => {
    const memory = Memory.open(tmp('tade-notes-'))
    const one = memory.remember('one', 'app', 'cli', NOW)
    memory.remember('two', 'app', 'cli', NOW)
    expect(() => memory.retire({ at: one.at }, '  ', 'cli')).toThrow(/say why/)
    expect(() => memory.retire({ at: 'never' }, 'why', 'cli')).toThrow(/no note was taken/)
    // Two notes said in the same millisecond are told apart by their words.
    expect(() => memory.retire({ at: one.at }, 'why', 'cli')).toThrow(/pass its words/)
    memory.retire({ at: one.at, text: 'one' }, 'why', 'cli')
    expect(() => memory.retire({ at: one.at, text: 'one' }, 'again', 'cli')).toThrow(
      /already retired by cli: why/,
    )
  })
})

describe('the cleanup, on open', () => {
  let client: Workbench | null = null

  afterEach(async () => {
    await client?.close().catch(() => {})
    client = null
  })

  it('retires a note about a task long gone, and the journal says so without its words', async () => {
    const home = tmp('tade-notes-')
    const memory = Memory.open(home)
    // Taken ten days ago, about a task that has no task file: gone.
    memory.remember('hover the purple too', 'tade/purple', 'orchestrator', Date.now() - 10 * DAY)
    memory.remember('a rule for the project', 'tade', 'orchestrator', Date.now() - 10 * DAY)
    memory.remember('fresh one', 'tade/purple-two', 'orchestrator', Date.now() - DAY)

    client = await Workbench.open({ home })
    expect(client.recallAll().map((n) => n.text)).toEqual(['fresh one', 'a rule for the project'])
    const retired = client.recallAll({ retired: true }).find((n) => n.retired)
    expect(retired?.retired).toMatchObject({ by: 'cleanup' })
    expect(retired?.retired?.because).toMatch(/^tade\/purple is gone/)

    const said = await client.log.read({ types: ['note_retired'] })
    expect(said).toHaveLength(1)
    expect(said[0]?.detail).toMatchObject({
      noted: retired?.at,
      scope: ['tade/purple'],
      by: 'cleanup',
      rule: 'gone',
    })
    expect(JSON.stringify(said[0])).not.toContain('hover the purple')

    // Opened again, nothing more to do and nothing more said.
    await client.close()
    client = await Workbench.open({ home })
    expect(await client.log.read({ types: ['note_retired'] })).toHaveLength(1)
  })

  it('says what it would retire without retiring it, when only asked', async () => {
    const home = tmp('tade-notes-')
    Memory.open(home).remember('x', 'tade/gone', 'cli', NOW - 10 * DAY)
    const memory = Memory.open(home)
    const log = { read: async () => [], append: async () => undefined }
    const would = await cleanupNotes({ home, memory, log }, 3, false, NOW)
    expect(would.map((one) => one.because)).toEqual([
      'tade/gone is gone, and nothing has happened to it since 10 days ago',
    ])
    expect(Memory.open(home).all()).toHaveLength(1)
  })
})

describe('retiring on somebody’s say-so', () => {
  let client: Workbench | null = null

  afterEach(async () => {
    await client?.close().catch(() => {})
    client = null
  })

  it('is refused without a line the person said, and done with one', async () => {
    const home = tmp('tade-notes-')
    client = await Workbench.open({ home })
    const note = client.remember('pause the queue', 'tade', 'orchestrator', 'Queue paused')

    // What an agent or a page said never gets into a `said` line.
    await expect(
      client.retireNote({ at: note.at, because: 'superseded', by: 'orchestrator', said: '' }),
    ).rejects.toThrow(/propose it and ask them/)
    await expect(
      client.retireNote({
        at: note.at,
        because: 'superseded',
        by: 'orchestrator',
        said: 'drop the pause note',
      }),
    ).rejects.toThrow(/is not their say-so/)
    expect(client.recallAll()).toHaveLength(1)

    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: "Don't pause agents anymore — drop the pause note" },
    })
    const retired = await client.retireNote({
      at: note.at,
      because: 'they want the queue to run',
      by: 'orchestrator',
      said: 'drop the pause note',
    })
    expect(retired.retired?.because).toBe('they want the queue to run')
    expect(client.recallAll()).toEqual([])
    const [line] = await client.log.read({ types: ['note_retired'] })
    expect(line?.detail).toMatchObject({
      by: 'orchestrator',
      explained: 'they want the queue to run',
      summary: 'Queue paused',
      said: "Don't pause agents anymore — drop the pause note",
    })
  })
})
