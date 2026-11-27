import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { readJournal } from '../src/events.ts'

// Reading the journal holds what it answers, never the file. On 26 Nov the
// Mac's window died after 21 hours in `JSON.parse` with its heap full
// (`node-2026-11-26-230937.ips`): its journal was 762 MB, and `readJournal`
// put every line of it into one array before filtering — on every look of a
// review watch, which asked it for the few thousand `watch_found` lines among
// a million.
//
// So a read is made on a heap far smaller than what the file would be once
// parsed. Each line is an array of empty objects, which weighs about ten times
// its text once it is objects, so a twelve-megabyte file is well past the
// ceiling held whole — a read that holds it dies exactly as the window did —
// and nothing near it a line at a time.

const run = promisify(execFile)
const EVENTS = fileURLToPath(new URL('../src/events.ts', import.meta.url))

/** The heap the read is given: what importing the journal costs, and room, but not the file. */
const HEAP_MB = 64

function line(seq: number, type: string, detail: string): string {
  return `{"seq":${seq},"ts":"2026-11-26T06:00:00.000Z","type":"${type}","urgency":"routine","task":null,"lane":null,"run":null,"detail":${detail}}`
}

describe('reading the journal', () => {
  it('holds the lines that match and lets the rest go, on a heap smaller than the file parsed', async () => {
    const home = tmp()
    const heavy = `{"schedule":"s","since":[${Array(4_000).fill('{}').join(',')}]}`
    const lines: string[] = []
    for (let seq = 1; seq <= 1_000; seq++) {
      lines.push(
        seq % 250 === 0
          ? line(seq, 'watch_found', `{"schedule":"s","key":"k${seq}"}`)
          : line(seq, 'watch_checked', heavy),
      )
    }
    writeFileSync(join(home, 'events.jsonl'), `${lines.join('\n')}\n`)
    const script = [
      `const { readJournal } = await import(${JSON.stringify(EVENTS)})`,
      `const got = await readJournal(${JSON.stringify(home)}, { types: ['watch_found'] })`,
      'console.log(JSON.stringify(got.map((one) => one.detail.key)))',
    ].join('\n')
    const { stdout } = await run(
      process.execPath,
      [`--max-old-space-size=${HEAP_MB}`, '--input-type=module', '-e', script],
      { timeout: 60_000 },
    )
    expect(JSON.parse(stdout)).toEqual(['k250', 'k500', 'k750', 'k1000'])
  }, 90_000)

  it('answers a limit with the newest that match, whatever it cut on the way', async () => {
    const home = tmp()
    const lines: string[] = []
    for (let seq = 1; seq <= 50; seq++) {
      lines.push(line(seq, seq % 2 === 0 ? 'warning' : 'note', '{}'))
    }
    writeFileSync(join(home, 'events.jsonl'), `${lines.join('\n')}\n{"seq":51,"torn`)
    const newest = await readJournal(home, { types: ['warning'], limit: 3 })
    expect(newest.map((one) => one.seq)).toEqual([46, 48, 50])
    const all = await readJournal(home, { types: ['warning'] })
    expect(all).toHaveLength(25)
    expect(await readJournal(home, { limit: 1 })).toEqual([expect.objectContaining({ seq: 50 })])
  })
})
