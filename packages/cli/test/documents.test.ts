import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { producesPath } from '@tade/core'
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

  let written = 0

  /** A journal line, written straight to the file the fold reads. */
  const wrote = (type: string, task: string, detail: Record<string, unknown>, minute = 0): void => {
    appendFileSync(
      join(home, 'events.jsonl'),
      `${JSON.stringify({
        // In the order written: the workbench reads its index by number.
        seq: ++written,
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

  /** A document on disk where Tade keeps them, and the line that says its task produced it. */
  const kept = (task: string, minutesAgo = 0): string => {
    const path = producesPath(home, task, 'AUDIT.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# what I found\n\nfour call sites\n')
    wrote('task_done', task, { by: 'agent', produces: path, bytes: 31 }, minutesAgo)
    return path
  }

  it('prints what a task produced', async () => {
    kept('app/audit')
    const result = await tade('documents', 'read', 'app/audit')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('# what I found\n\nfour call sites')
  })

  it('says a task produced nothing rather than printing nothing', async () => {
    const result = await tade('documents', 'read', 'app/nothing')
    expect(result.code).toBe(1)
  })

  it('deletes one with the reason it is going, and the journal says so', async () => {
    const path = kept('app/audit')
    const result = await tade('documents', 'delete', 'app/audit', '--why', 'superseded')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`deleted ${path}`)
    expect(existsSync(path)).toBe(false)
    const journal = readFileSync(join(home, 'events.jsonl'), 'utf8')
    expect(journal).toContain('"document_deleted"')
    expect(journal).toContain('"explained":"superseded"')
    const all = await tade('documents', '--all')
    expect(all.stdout).toContain('you deleted it: superseded')
  })

  it('will not delete one without a reason', async () => {
    const path = kept('app/audit')
    const result = await tade('documents', 'delete', 'app/audit')
    expect(result.code).not.toBe(0)
    expect(existsSync(path)).toBe(true)
  })

  it('says which a cleanup would take before taking them, and never an undecided one', async () => {
    const month = 40 * 24 * 60
    const decided = kept('app/decided', month + 2)
    wrote(
      'document_triaged',
      'app/decided',
      { path: decided, by: 'person', decided: 'nothing follows' },
      month,
    )
    const undecided = kept('app/undecided', month + 2)
    const would = await tade('documents', 'cleanup')
    expect(would.stdout).toContain('nothing has been deleted yet')
    expect(would.stdout).toContain('app/decided')
    expect(would.stdout).not.toContain('app/undecided')
    expect(existsSync(decided)).toBe(true)

    const took = await tade('documents', 'cleanup', '--apply')
    expect(took.code).toBe(0)
    expect(took.stdout).toContain('Deleted 1 document')
    expect(existsSync(decided)).toBe(false)
    expect(existsSync(undecided)).toBe(true)
  })

  it('says a document was destroyed with its task rather than saying nothing', async () => {
    wrote('task_done', 'app/audit', { by: 'agent', produces: '/h/t/GONE.md' }, 20)
    wrote('task_removed', 'app/audit', { forced: true }, 10)
    const result = await tade('documents')
    expect(result.stdout).toContain('removed with its task')
  })
})
