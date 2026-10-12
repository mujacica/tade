import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  documentsIn,
  type EventInput,
  producesPath,
  type TadeEvent,
  taskDir,
  taskDocumentsDir,
} from '@tade/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  cleanupDocuments,
  type DocumentHome,
  deleteDocument,
  documentOf,
  documentsFolder,
  settleDocuments,
} from '../src/documents.ts'

// Letting a document go, and putting the documents folder in order.
//
// A document outlives its task, so what deletes one is a person asking or the
// cleanup — and the cleanup may only take one somebody decided about. These
// are the file halves of that, against a real home on disk and a journal held
// in memory, because the rule itself is core's (`documentsToCompact`) and is
// tested there.

const DAY = 86_400_000

describe('the documents folder', () => {
  let home: string
  let lines: TadeEvent[]
  let now: number
  let deps: DocumentHome

  const append = async (input: EventInput): Promise<TadeEvent> => {
    const line: TadeEvent = {
      seq: lines.length + 1,
      ts: new Date(now).toISOString(),
      type: input.type,
      urgency: 'notable',
      task: input.task ?? null,
      lane: null,
      run: null,
      detail: input.detail ?? {},
    }
    lines.push(line)
    return line
  }

  /** A task that produced `name`, written at `path`, finished now. */
  const produced = async (task: string, path: string): Promise<void> => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# what I found\n')
    await append({ type: 'task_done', task, detail: { by: 'agent', produces: path, bytes: 15 } })
  }

  beforeEach(() => {
    home = tmp('tade-documents-')
    lines = []
    now = Date.UTC(2026, 8, 1, 9)
    deps = {
      home,
      log: { read: async () => [...lines], append },
      now: () => new Date(now),
    }
  })

  it('deletes one somebody asked for, undecided or not, and writes down who and why', async () => {
    const path = producesPath(home, 'app/audit', 'notes/AUDIT.md')
    await produced('app/audit', path)
    const gone = await deleteDocument(deps, {
      task: 'app/audit',
      path,
      why: 'superseded by the second audit',
      by: 'you',
    })
    expect(gone).toMatchObject({ state: 'deleted', deleted: { by: 'you' } })
    expect(existsSync(path)).toBe(false)
    // The folders it left empty go with it: nothing of the task is left behind.
    expect(existsSync(taskDocumentsDir(home, 'app/audit'))).toBe(false)
    expect(lines.at(-1)).toMatchObject({
      type: 'document_deleted',
      task: 'app/audit',
      detail: { path, by: 'you', explained: 'superseded by the second audit' },
    })
    expect(documentsIn(lines)[0]?.state).toBe('deleted')
  })

  it('refuses with no reason, a path the journal never had, and one already gone', async () => {
    const path = producesPath(home, 'app/audit', 'AUDIT.md')
    await produced('app/audit', path)
    await expect(deleteDocument(deps, { task: 'app/audit', path, why: ' ' })).rejects.toThrow(
      'say why',
    )
    await expect(
      deleteDocument(deps, { task: 'app/audit', path: '/etc/hosts', why: 'x' }),
    ).rejects.toThrow('is not a document')
    await deleteDocument(deps, { task: 'app/audit', path, why: 'done with it' })
    await expect(deleteDocument(deps, { task: 'app/audit', path, why: 'again' })).rejects.toThrow(
      'already gone',
    )
  })

  it('never deletes a file outside that task’s folders, whatever the journal says', async () => {
    // The path comes out of the journal, and a line there is never permission
    // to delete anything else on the disk.
    const elsewhere = join(home, 'config.yaml')
    writeFileSync(elsewhere, 'keep me\n')
    await append({ type: 'task_done', task: 'app/audit', detail: { produces: elsewhere } })
    await expect(
      deleteDocument(deps, { task: 'app/audit', path: elsewhere, why: 'tidy' }),
    ).rejects.toThrow('will not delete it')
    expect(existsSync(elsewhere)).toBe(true)
    expect(lines.some((line) => line.type === 'document_deleted')).toBe(false)
  })

  it('cleans up only what was decided about long enough ago, and says first', async () => {
    const decided = producesPath(home, 'app/decided', 'A.md')
    const undecided = producesPath(home, 'app/undecided', 'B.md')
    await produced('app/decided', decided)
    await produced('app/undecided', undecided)
    await append({
      type: 'document_triaged',
      task: 'app/decided',
      detail: { path: decided, by: 'person', decided: 'nothing follows' },
    })
    now += 40 * DAY

    const would = await cleanupDocuments(deps, { keepDays: 30, apply: false })
    expect(would.map((one) => one.document.task)).toEqual(['app/decided'])
    // Saying is not doing.
    expect(existsSync(decided)).toBe(true)

    const took = await cleanupDocuments(deps, { keepDays: 30, apply: true })
    expect(took).toHaveLength(1)
    expect(existsSync(decided)).toBe(false)
    expect(existsSync(undecided)).toBe(true)
    expect(lines.at(-1)?.detail).toMatchObject({ by: 'cleanup', path: decided })
    expect(String(lines.at(-1)?.detail.explained)).toContain(
      'cleaned up: person decided about it 40 days',
    )
  })

  it('moves what an older agent left in its task’s folder on open, then cleans up', async () => {
    const before = join(taskDir(home, 'app/old'), 'notes', 'R.md')
    await produced('app/old', before)
    const done = await settleDocuments(deps, 30)
    expect(done).toEqual({ moved: 1, deleted: [] })
    const where = producesPath(home, 'app/old', 'notes/R.md')
    expect(existsSync(where)).toBe(true)
    expect(existsSync(before)).toBe(false)
    expect(lines.at(-1)).toMatchObject({
      type: 'document_moved',
      detail: { from: before, into: where },
    })
    expect(documentsIn(lines)[0]).toMatchObject({ path: where, state: 'written' })
    // And a second open has nothing to do.
    expect(await settleDocuments(deps, 30)).toEqual({ moved: 0, deleted: [] })
  })

  it('says what went wrong rather than throwing on the way open', async () => {
    deps = { ...deps, log: { read: async () => Promise.reject(new Error('disk')), append } }
    expect(await settleDocuments(deps, 30)).toEqual({ moved: 0, deleted: [] })
    expect(lines.at(-1)).toMatchObject({ type: 'warning' })
    expect(String(lines.at(-1)?.detail.message)).toContain('disk')
  })

  it('names the folder for an agent only once there is something in it', () => {
    expect(documentsFolder(home, 'app')).toBe(null)
    mkdirSync(taskDocumentsDir(home, 'app/audit'), { recursive: true })
    expect(documentsFolder(home, 'app')).toBe(join(home, 'projects', 'app', 'documents'))
  })

  it('finds a document still being written, wherever its agent was told to put it', async () => {
    const dir = taskDir(home, 'app/live')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'task.yaml'),
      [
        'id: app/live',
        'project: app',
        'intent_spoken: write it up',
        'created: 2026-09-01T09:00:00Z',
        'produces: R.md',
      ].join('\n'),
    )
    expect(await documentOf(home, 'app/live')).toBe(producesPath(home, 'app/live', 'R.md'))
    writeFileSync(join(dir, 'R.md'), 'half\n')
    expect(await documentOf(home, 'app/live')).toBe(join(dir, 'R.md'))
    expect(await documentOf(home, 'app/nothing')).toBe(null)
  })
})
