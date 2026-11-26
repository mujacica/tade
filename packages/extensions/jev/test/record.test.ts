import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { forgetRead, recordOf } from '../src/record.ts'
import { statusLine } from '../src/report.ts'
import { NOW } from './harness.ts'

// The looks of every Jev watch are one record: the strip and the brief read
// `looks[0]` as the last look there was, whichever watch took it.

function schedule(id: string, watch: string): string {
  return `${JSON.stringify({
    op: 'set',
    by: 'you',
    at: new Date(NOW).toISOString(),
    schedule: {
      id,
      name: id,
      project: 'tade',
      said: '',
      when: { every: '1h' },
      does: { kind: 'watch', watch, input: {}, found: 'ask', most: 3 },
      missed: 'once',
      by: 'you',
      created: new Date(NOW).toISOString(),
    },
  })}\n`
}

function look(seq: number, schedule: string, minutesAgo: number, problem?: string): string {
  return `${JSON.stringify({
    seq,
    ts: new Date(NOW - minutesAgo * 60_000).toISOString(),
    type: 'watch_checked',
    urgency: 'routine',
    detail: { schedule, found: 0, ...(problem ? { problem } : { since: 'x' }) },
  })}\n`
}

function context(home: string): ExtensionContext {
  return {
    extension: 'jev',
    settings: {},
    projects: [],
    project: () => {
      throw new Error('no projects here')
    },
    env: {},
    secret: () => null,
    fetch: async () => {
      throw new Error('it reached the network')
    },
    exec: async () => ({ ok: false, code: 1, stdout: '', stderr: 'nothing runs here' }),
    home,
    now: () => NOW,
  }
}

describe('the looks of several Jev watches', () => {
  it('are newest first across all of them, not one watch after another', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tade-jev-record-'))
    // jev.review is listed first and looked longest ago, and it could not;
    // jev.verdicts looked since, and it could.
    writeFileSync(
      join(home, 'schedules.jsonl'),
      schedule('jev-review', 'jev.review') + schedule('jev-verdicts', 'jev.verdicts'),
    )
    writeFileSync(
      join(home, 'events.jsonl'),
      look(1, 'jev-review', 30, 'no key') +
        look(2, 'jev-verdicts', 20) +
        look(3, 'jev-review', 10, 'no key') +
        look(4, 'jev-verdicts', 5),
    )

    forgetRead()
    const record = await recordOf(context(home))

    expect(record.looks.map((one) => one.at)).toEqual(
      [5, 10, 20, 30].map((minutes) => NOW - minutes * 60_000),
    )
    // The last look there was worked, so the strip does not say it could not.
    expect(record.looks[0]?.problem).toBeNull()
    expect(statusLine(record).strip).not.toContain('no key')
  })
})
