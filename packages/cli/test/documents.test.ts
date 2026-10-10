import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// Looking at what the agents wrote, from a terminal.
//
// The person who closes the agents is the person who loses the documents, and
// until this there was nowhere at the machine to see one at all: the only
// surface was a line in a briefing a person talking to Tade may never read.
//
// The journal is read directly, so this answers with a window open or shut.

describe('tade documents', () => {
  let home: string
  let env: Record<string, string>

  const tade = (...args: string[]): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim() }))
    })

  /** A journal line, written straight to the file the fold reads. */
  const wrote = (type: string, task: string, detail: Record<string, unknown>, minute = 0): void => {
    appendFileSync(
      join(home, 'events.jsonl'),
      `${JSON.stringify({
        seq: minute + 1,
        ts: new Date(Date.now() - minute * 60_000).toISOString(),
        type,
        urgency: 'notable',
        task,
        lane: null,
        run: null,
        detail,
      })}\n`,
    )
  }

  beforeEach(() => {
    home = tmp('tade-cli-documents-')
    mkdirSync(home, { recursive: true })
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
  })

  it('says so when no task has produced one', async () => {
    const result = await tade('documents')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('no task has produced a document yet')
  })

  it('names what is waiting, with its path and what its agent said', async () => {
    wrote('task_done', 'cruxed/lake-parity', {
      by: 'agent',
      summary: 'seventeen rows measured, eight open questions',
      produces: '/h/.tade/projects/cruxed/tasks/lake-parity/LAKE-PARITY.md',
      bytes: 41_955,
    })
    const result = await tade('documents')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('cruxed/lake-parity produced')
    expect(result.stdout).toContain('LAKE-PARITY.md (41 KB)')
    expect(result.stdout).toContain('nothing has been done about it yet')
    expect(result.stdout).toContain('seventeen rows measured')
  })

  it('stops naming one once somebody has said what they decided', async () => {
    wrote('task_done', 'app/audit', { by: 'agent', produces: '/h/t/AUDIT.md' }, 10)
    wrote(
      'document_triaged',
      'app/audit',
      { path: '/h/t/AUDIT.md', by: 'person', decided: 'nothing follows: already guarded' },
      5,
    )
    const waiting = await tade('documents')
    expect(waiting.stdout).toBe(
      'nothing waiting: every document a task produced has been decided about',
    )
    // And --all still has it, with what was decided, in their words.
    const all = await tade('documents', '--all')
    expect(all.stdout).toContain('person read it and decided: nothing follows: already guarded')
  })

  it('still names one five days old, because the file is still there to read', async () => {
    wrote('task_done', 'app/audit', { by: 'agent', produces: '/h/t/OLD.md' }, 5 * 24 * 60)
    const result = await tade('documents')
    expect(result.stdout).toContain('/h/t/OLD.md')
  })

  it('says a document was destroyed with its task rather than saying nothing', async () => {
    wrote('task_done', 'app/audit', { by: 'agent', produces: '/h/t/GONE.md' }, 20)
    wrote('task_removed', 'app/audit', { forced: true }, 10)
    const result = await tade('documents')
    expect(result.stdout).toContain('removed with its task')
  })
})
