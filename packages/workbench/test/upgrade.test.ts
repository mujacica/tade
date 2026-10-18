import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { runningVersion } from '../src/programs.ts'
import { openedAs, startsAs } from '../src/upgrade.ts'
import { Workbench } from '../src/workbench.ts'

// What `tade host upgrade` reads of the machine besides Tade itself: which
// Tade holds the home, out of the journal, and whether the Tade on disk
// starts — each against the real thing: a journal a workbench wrote, and a
// process run.

const opened = (seq: number, detail: Record<string, unknown>) =>
  `${JSON.stringify({
    seq,
    ts: '2026-10-18T00:00:00.000Z',
    type: 'tade_opened',
    urgency: 'notable',
    task: null,
    lane: null,
    run: null,
    detail,
  })}\n`

describe('which Tade holds the home', () => {
  it('is what the window with that pid wrote as it opened: its version and its lanes', async () => {
    const home = tmp('tade-opened-')
    const client = await Workbench.open({ home })
    await client.close()
    expect(await openedAs(home, process.pid)).toEqual({ version: runningVersion(), lanes: 0 })
  })

  it('is the newest opening with that pid, null for one that never opened, and a version unsaid by an older Tade', async () => {
    const home = tmp('tade-opened-')
    writeFileSync(
      join(home, 'events.jsonl'),
      opened(1, { pid: 10, version: '0.2.1', lanes: 3 }) +
        opened(2, { pid: 20, lanes: 1 }) +
        opened(3, { pid: 10, version: '0.2.3', lanes: 4 }),
    )
    expect(await openedAs(home, 10)).toEqual({ version: '0.2.3', lanes: 4 })
    expect(await openedAs(home, 20)).toEqual({ version: null, lanes: 1 })
    expect(await openedAs(home, 30)).toBeNull()
    expect(await openedAs(tmp('tade-no-journal-'), 10)).toBeNull()
  })

  it('reads the whole journal where the opening is further back than its tail', async () => {
    const home = tmp('tade-opened-')
    const path = join(home, 'events.jsonl')
    writeFileSync(path, opened(1, { pid: 10, version: '0.2.2', lanes: 2 }))
    // Nine megabytes of other lines after it: past the tail looked at first.
    const line = `${JSON.stringify({ seq: 2, ts: '2026-10-18T00:00:00.000Z', type: 'lane_bytes', urgency: 'trace', task: null, lane: null, run: null, detail: { pad: 'x'.repeat(900) } })}\n`
    appendFileSync(path, line.repeat(Math.ceil((9 * 1024 * 1024) / line.length)))
    expect(await openedAs(home, 10)).toEqual({ version: '0.2.2', lanes: 2 })
  })
})

describe('whether the Tade on disk starts', () => {
  // A program that is handed `--version` as a word of its own, as `tade` is.
  const script = (source: string) => [process.execPath, '-e', source, '--']

  it('answers the version it printed', async () => {
    expect(await startsAs(script('console.log("0.2.4")'))).toEqual({
      version: '0.2.4',
      said: null,
    })
  })

  it('says why where it did not: what it printed on standard error, or how it ended', async () => {
    const thrown = await startsAs(
      script('console.error("TypeError: TEXT_ENCODINGS.union is not a function"); process.exit(1)'),
    )
    expect(thrown).toEqual({
      version: null,
      said: 'TypeError: TEXT_ENCODINGS.union is not a function',
    })
    expect(await startsAs(script('process.exit(3)'))).toEqual({
      version: null,
      said: 'it exited 3',
    })
    expect(await startsAs(script('console.log("no version here")'))).toEqual({
      version: null,
      said: 'it exited 0',
    })
  })
})
