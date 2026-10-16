import { describe, expect, it } from 'vitest'
import type { EventType, TadeEvent } from '../src/events.ts'
import {
  actedOnSays,
  approvedFrom,
  compactedSays,
  documentMovedTo,
  documentsIn,
  documentsToCompact,
  everyDocumentSays,
  producedClause,
  producesPath,
  producesProblem,
  waitingDocuments,
} from '../src/produces.ts'

let seq = 0
function event(
  type: EventType,
  task: string,
  detail: Record<string, unknown> = {},
  minute = 0,
): TadeEvent {
  seq++
  return {
    seq,
    ts: new Date(Date.UTC(2026, 8, 15, 9, minute)).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

/** The timestamp `event` writes for a minute, so an assertion can name it. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 15, 9, minute)).toISOString()
}

describe('a name a task may produce', () => {
  it('takes a file name, and a path under the folder', () => {
    expect(producesProblem('scope-audit.md')).toBe(null)
    expect(producesProblem('notes/scope-audit.md')).toBe(null)
    expect(producesProblem('AUDIT.md')).toBe(null)
  })

  it('refuses a path of its own, wherever it would land', () => {
    // Not "outside the repository" any more: the document goes in the task's
    // documents folder in Tade's home, so what is refused is anything that is
    // not a name inside it — an absolute path included, however harmless.
    expect(producesProblem('/tmp/audit.md')).toContain('a path of its own')
    expect(producesProblem('~/audit.md')).toContain('a path of its own')
    expect(producesProblem('C:\\audit.md')).toContain('a path of its own')
    expect(producesProblem('../elsewhere/audit.md')).toContain("climbs out of the task's documents")
    expect(producesProblem('notes/../../out.md')).toContain("climbs out of the task's documents")
  })

  it('refuses nothing at all, which is the shape of a field left empty', () => {
    expect(producesProblem('   ')).toContain('name the file it writes')
  })

  it('goes in the project’s documents folder in Tade’s home, and nowhere in the project', () => {
    // The one reader: the sentence the agent is told, the path on `task_done`
    // and the file Tade looks for are this string — beside the task folders
    // and never in one, because a task's folder goes when the task does.
    expect(producesPath('/h/.tade', 'shop/scope-audit', 'audit.md')).toBe(
      '/h/.tade/projects/shop/documents/scope-audit/audit.md',
    )
    expect(producesPath('/h/.tade', 'shop/scope-audit', ' notes/audit.md ')).toBe(
      '/h/.tade/projects/shop/documents/scope-audit/notes/audit.md',
    )
  })

  it('knows where one written under the old rule belongs now, and nothing else', () => {
    expect(
      documentMovedTo(
        '/h/.tade',
        'shop/scope-audit',
        '/h/.tade/projects/shop/tasks/scope-audit/notes/a.md',
      ),
    ).toBe('/h/.tade/projects/shop/documents/scope-audit/notes/a.md')
    // Already where documents are kept, another task's folder, or anywhere
    // else: not a document to move.
    expect(
      documentMovedTo(
        '/h/.tade',
        'shop/scope-audit',
        '/h/.tade/projects/shop/documents/scope-audit/a.md',
      ),
    ).toBe(null)
    expect(
      documentMovedTo('/h/.tade', 'shop/scope-audit', '/h/.tade/projects/shop/tasks/other/a.md'),
    ).toBe(null)
    expect(documentMovedTo('/h/.tade', 'shop/scope-audit', '/etc/passwd')).toBe(null)
  })
})

describe('a document outliving its task', () => {
  const done = (minute = 1) =>
    event('task_done', 'app/audit', { by: 'agent', produces: '/h/a.md', summary: 's' }, minute)

  it('is still written after a removal that says it kept it', () => {
    const [one] = documentsIn([done(), event('task_removed', 'app/audit', { kept: true }, 2)])
    expect(one).toMatchObject({ state: 'written', removedAt: null, summary: 's' })
  })

  it('went with its task under a removal from before, which says nothing', () => {
    const [one] = documentsIn([done(), event('task_removed', 'app/audit', {}, 2)])
    expect(one).toMatchObject({ state: 'gone', removedAt: at(2) })
  })

  it('is remembered from a kept removal where its agent never finished', () => {
    const [one] = documentsIn([
      event('task_removed', 'app/audit', { produces: '/h/a.md', written: true, kept: true }, 2),
    ])
    expect(one).toMatchObject({ task: 'app/audit', path: '/h/a.md', state: 'written' })
  })

  it('follows a move, keeping everything that had come of it', () => {
    const events = [
      done(),
      event('document_triaged', 'app/audit', { path: '/h/a.md', by: 'person', decided: 'ok' }, 2),
      event('document_moved', 'app/audit', { from: '/h/a.md', into: '/h/b.md' }, 3),
    ]
    const all = documentsIn(events)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ path: '/h/b.md', triaged: { decided: 'ok' } })
  })

  it('says who deleted it and why, and is no longer waiting', () => {
    const [one] = documentsIn([
      done(),
      event('document_deleted', 'app/audit', { path: '/h/a.md', by: 'you', explained: 'stale' }, 2),
    ])
    expect(one).toMatchObject({ state: 'deleted', deleted: { by: 'you', why: 'stale' } })
    expect(waitingDocuments([one!], Date.UTC(2026, 8, 15, 10))).toEqual([])
    expect(producedClause(one!)).toBe('produced /h/a.md, and you deleted it: stale')
  })

  it('lists every one, kept and deleted, when asked for all', () => {
    expect(everyDocumentSays([])).toBe('No task has produced a document yet.')
    const said = everyDocumentSays(documentsIn([done()]))
    expect(said).toContain('kept in Tade’s home after their tasks are removed')
    expect(said).toContain('app/audit produced /h/a.md')
  })
})

describe('what the cleanup may take', () => {
  const day = 86_400_000
  const keep = 30 * day
  const decided = (minute: number) =>
    event(
      'document_triaged',
      'app/audit',
      { path: '/h/a.md', by: 'person', decided: 'done' },
      minute,
    )
  const done = event('task_done', 'app/audit', { by: 'agent', produces: '/h/a.md' }, 1)
  const later = Date.UTC(2026, 9, 20, 9)

  it('never takes one nobody decided about, however old', () => {
    expect(documentsToCompact([done], Date.UTC(2030, 0, 1), keep)).toEqual([])
  })

  it('takes one decided about long enough ago, and says why', () => {
    const [one] = documentsToCompact([done, decided(2)], later, keep)
    expect(one?.document.task).toBe('app/audit')
    expect(one?.because).toBe('person decided about it 34 days ago (done)')
  })

  it('keeps one decided about recently', () => {
    expect(documentsToCompact([done, decided(2)], Date.UTC(2026, 8, 30), keep)).toEqual([])
  })

  it('keeps one whose follow-up is still under way, and takes it once that has finished', () => {
    const queued = event('task_created', 'app/fix', { after: ['app/audit'] }, 3)
    expect(documentsToCompact([done, decided(2), queued], later, keep)).toEqual([])
    const started = event('run_started', 'app/fix', {}, 4)
    expect(documentsToCompact([done, decided(2), queued, started], later, keep)).toEqual([])
    const finished = event('task_done', 'app/fix', { by: 'agent' }, 5)
    const [one] = documentsToCompact([done, decided(2), queued, started, finished], later, keep)
    expect(one?.because).toContain('everything queued off it has finished')
  })

  it('keeps one whose own agent was started again, which may be rewriting it', () => {
    const again = event('run_started', 'app/audit', {}, 3)
    expect(documentsToCompact([done, decided(2), again], later, keep)).toEqual([])
  })

  it('takes nothing already deleted, gone or never written', () => {
    const deleted = event(
      'document_deleted',
      'app/audit',
      { path: '/h/a.md', by: 'you', explained: 'x' },
      3,
    )
    expect(documentsToCompact([done, decided(2), deleted], later, keep)).toEqual([])
    const missing = event(
      'task_done',
      'app/b',
      { by: 'agent', produces: '/h/b.md', missing: true },
      1,
    )
    const triagedB = event(
      'document_triaged',
      'app/b',
      { path: '/h/b.md', by: 'p', decided: 'x' },
      2,
    )
    expect(documentsToCompact([missing, triagedB], later, keep)).toEqual([])
  })

  it('says what it would take and what it took', () => {
    const taken = documentsToCompact([done, decided(2)], later, keep)
    expect(compactedSays(taken, false)).toContain('nothing has been deleted yet')
    expect(compactedSays(taken, true)).toContain('Deleted 1 document')
    expect(compactedSays([], false)).toContain('Nothing to clean up')
  })
})

describe('documents finished tasks produced', () => {
  it('is the path and the summary off the line that says it finished', () => {
    const [one, ...rest] = documentsIn([
      event('task_done', 'app/audit', {
        by: 'agent',
        summary: 'Four call sites take the token twice.',
        produces: 'notes/scope-audit.md',
      }),
    ])
    expect(rest).toEqual([])
    expect(one).toMatchObject({
      task: 'app/audit',
      path: 'notes/scope-audit.md',
      summary: 'Four call sites take the token twice.',
      missing: false,
      followed: [],
      reused: false,
    })
  })

  it('says nothing about a task that finished without naming one', () => {
    expect(
      documentsIn([event('task_done', 'app/refunds', { by: 'agent', summary: 'done' })]),
    ).toEqual([])
  })

  it('counts work queued off it afterwards, and never a plan that named it before', () => {
    const [one] = documentsIn([
      // A plan written before the research ran waits on it: that is the plan
      // waiting, not somebody deciding what the document turned out to say.
      event('task_created', 'app/planned-earlier', { after: ['app/audit'] }, 1),
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 2),
      event('task_created', 'app/fix-scopes', { after: ['app/audit'] }, 3),
      event('task_created', 'app/unrelated', {}, 4),
    ])
    expect(one?.followed).toEqual(['app/fix-scopes'])
    expect(producedClause(one!)).toBe(
      'produced notes/audit.md, and app/fix-scopes was queued off it',
    )
  })

  it('counts its own agent being started again, which is the other thing to do about one', () => {
    const [one] = documentsIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 1),
      event('run_started', 'app/audit', {}, 2),
    ])
    expect(one?.reused).toBe(true)
    expect(producedClause(one!)).toBe(
      'produced notes/audit.md, and its own agent was started again',
    )
  })

  it('keeps a removed task’s document and says it is gone, rather than reporting nothing', () => {
    // It used to be dropped, on the grounds that the path no longer says
    // where to look. That read as "no document ever existed": twelve of
    // thirteen on one machine had been destroyed by a cleanup, six inside two
    // seconds, and nothing anywhere could say so.
    const [one] = documentsIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 1),
      event('task_removed', 'app/audit', {}, 2),
    ])
    expect(one).toMatchObject({ state: 'gone', removedAt: at(2) })
    expect(producedClause(one!)).toContain('it was removed with its task')
  })

  it('says a document existed when its task was removed having never finished', () => {
    // An agent killed after writing never got a receipt, so the removal is
    // the only thing that can say there was anything there.
    const [one] = documentsIn([
      event('task_created', 'app/audit', { produces: 'notes/audit.md' }, 1),
      event('task_removed', 'app/audit', { produces: '/h/notes/audit.md', written: true }, 2),
    ])
    expect(one).toMatchObject({ task: 'app/audit', path: '/h/notes/audit.md', state: 'gone' })
  })

  it('says nothing about a task removed having named a document and written none', () => {
    expect(
      documentsIn([
        event('task_created', 'app/audit', { produces: 'notes/audit.md' }, 1),
        event('task_removed', 'app/audit', { produces: '/h/notes/audit.md' }, 2),
      ]),
    ).toEqual([])
  })

  it('starts again when a task finishes a second time', () => {
    const [one] = documentsIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 1),
      event('task_created', 'app/fix-scopes', { after: ['app/audit'] }, 2),
      event('run_started', 'app/audit', {}, 3),
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 4),
    ])
    expect(one).toMatchObject({ followed: [], reused: false })
  })

  it('says a task named a document and did not write one, rather than sending anybody to it', () => {
    const [one] = documentsIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md', missing: true }),
    ])
    expect(one?.missing).toBe(true)
    expect(producedClause(one!)).toBe('said it would produce notes/audit.md and did not write it')
  })
})

describe('a document somebody has decided about', () => {
  const produced = (minute = 1) =>
    event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, minute)
  const triaged = (minute: number, decided = 'nothing follows: it argues for what we already do') =>
    event(
      'document_triaged',
      'app/audit',
      { path: 'notes/audit.md', by: 'person', decided },
      minute,
    )

  it('carries whose decision it was and their sentence, never reworded', () => {
    const [one] = documentsIn([produced(1), triaged(2)])
    expect(one?.triaged).toEqual({
      by: 'person',
      decided: 'nothing follows: it argues for what we already do',
      at: at(2),
      approved: false,
    })
    expect(producedClause(one!)).toContain(
      'person read it and decided: nothing follows: it argues for what we already do',
    )
  })

  it('stops waiting on anybody, which is the whole point of being able to say it', () => {
    const now = Date.UTC(2026, 8, 15, 10)
    expect(waitingDocuments(documentsIn([produced(1)]), now)).toHaveLength(1)
    expect(waitingDocuments(documentsIn([produced(1), triaged(2)]), now)).toEqual([])
  })

  it('needs a sentence: a record with none is not a record', () => {
    const [one] = documentsIn([produced(1), triaged(2, '   ')])
    expect(one?.triaged).toBe(null)
  })

  it('is not a verdict on what the task wrote next time', () => {
    // A reopened task has written something else, and a decision about what it
    // used to say is not a decision about that.
    const [one] = documentsIn([produced(1), triaged(2), produced(3)])
    expect(one?.triaged).toBe(null)
    expect(waitingDocuments([one!], Date.UTC(2026, 8, 15, 10))).toHaveLength(1)
  })

  it('does nothing without a path, which would otherwise clear every one of a task’s', () => {
    const two = documentsIn([
      produced(1),
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/second.md' }, 2),
      event('document_triaged', 'app/audit', { by: 'person', decided: 'read them both' }, 3),
    ])
    expect(two.map((one) => one.triaged)).toEqual([null, null])
  })

  it('is about one document, where a task has produced two', () => {
    const two = documentsIn([
      produced(1),
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/second.md' }, 2),
      triaged(3),
    ])
    expect(two.map((one) => [one.path, one.triaged !== null])).toEqual([
      ['notes/audit.md', true],
      ['notes/second.md', false],
    ])
  })
})

describe('what is still waiting on somebody', () => {
  const now = Date.UTC(2026, 8, 20, 9)
  const old = (minute: number) =>
    event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, minute)

  it('never ages out while the file is there, however long nobody reads it', () => {
    // Five days on. It used to fall off after three, which lost a document
    // nobody had read on the fourth morning without a word.
    expect(waitingDocuments(documentsIn([old(1)]), now)).toHaveLength(1)
  })

  it('retires one whose file is gone, because nothing can be done about it', () => {
    const gone = documentsIn([old(1), event('task_removed', 'app/audit', {}, 2)])
    expect(waitingDocuments(gone, now)).toEqual([])
  })

  it('still names a freshly destroyed one, aged from when it went and not from when it was written', () => {
    const events: TadeEvent[] = [
      {
        ...event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }),
        ts: new Date(Date.UTC(2026, 8, 15, 9)).toISOString(),
      },
      {
        ...event('task_removed', 'app/audit', {}),
        ts: new Date(now - 60_000).toISOString(),
      },
    ]
    expect(waitingDocuments(documentsIn(events), now)).toHaveLength(1)
  })

  it('is not cleared by its own agent being started again', () => {
    // `run_started` also fires for a window reopening what it left running, a
    // harness changed under it and a model picked. A list whose whole purpose
    // is that a document is not lost may not be emptied by a relaunch — so
    // `reused` is said beside one and never clears it.
    const relaunched = documentsIn([old(1), event('run_started', 'app/audit', {}, 2)])
    expect(relaunched[0]?.reused).toBe(true)
    expect(waitingDocuments(relaunched, now)).toHaveLength(1)
  })

  it('leaves out one that work was queued off, as it always did', () => {
    const followed = documentsIn([
      old(1),
      event('task_created', 'app/fix-scopes', { after: ['app/audit'] }, 2),
    ])
    expect(waitingDocuments(followed, now)).toEqual([])
  })
})

describe('what has been done about a document', () => {
  it('is nothing, until something is', () => {
    expect(actedOnSays({})).toBe('nothing has been done about it yet')
  })

  it('names every task queued off it', () => {
    expect(actedOnSays({ followed: ['app/one', 'app/two'] })).toBe(
      'app/one, app/two were queued off it',
    )
  })

  it('says both, where both happened', () => {
    expect(actedOnSays({ followed: ['app/one'], reused: true })).toBe(
      'app/one was queued off it, and its own agent was started again',
    )
  })
})

describe('a document handed over before its task finished', () => {
  const ready = (minute: number, detail: Record<string, unknown> = {}) =>
    event(
      'document_ready',
      'app/plan',
      { produces: 'p/plan.md', asked: 'A or B?', waits: true, bytes: 2048, ...detail },
      minute,
    )
  const done = (minute: number) =>
    event(
      'task_done',
      'app/plan',
      { by: 'agent', produces: 'p/plan.md', summary: 'planned' },
      minute,
    )
  const triaged = (minute: number, detail: Record<string, unknown> = {}) =>
    event(
      'document_triaged',
      'app/plan',
      { path: 'p/plan.md', by: 'orchestrator', decided: 'they chose B', ...detail },
      minute,
    )

  it('is waiting at once, with what its agent asked and that it has not finished', () => {
    const [one] = documentsIn([ready(1)])
    expect(one).toMatchObject({
      task: 'app/plan',
      path: 'p/plan.md',
      state: 'written',
      asked: 'A or B?',
      finished: false,
      bytes: 2048,
      triaged: null,
    })
    expect(waitingDocuments([one!], Date.UTC(2026, 8, 15, 10))).toHaveLength(1)
    // What it asked is said until somebody answers it, in its agent's words.
    expect(producedClause(one!)).toBe(
      'produced p/plan.md (2048 bytes), and nothing has been done about it yet; its agent asks: A or B?',
    )
  })

  it('is asked again when it is handed over again, and the earlier answer is not this one', () => {
    const [one] = documentsIn([ready(1), triaged(2), ready(3, { asked: 'Is B right now?' })])
    expect(one?.triaged).toBe(null)
    expect(one?.asked).toBe('Is B right now?')
  })

  it('keeps the answer when its agent finishes the run that was answered', () => {
    // Handed over, answered, finished: the finish is not a new question, so
    // the document is not put back on the list as unread.
    const [one] = documentsIn([ready(1), triaged(2, { approved: true }), done(3)])
    expect(one).toMatchObject({ finished: true, summary: 'planned', asked: 'A or B?' })
    expect(one?.triaged).toMatchObject({ decided: 'they chose B', approved: true })
    expect(waitingDocuments([one!], Date.UTC(2026, 8, 15, 10))).toEqual([])
  })

  it('is a new document when its task was opened again before it finished', () => {
    const reopened = event('run_started', 'app/plan', {}, 3)
    const [one] = documentsIn([ready(1), triaged(2), reopened, done(4)])
    expect(one?.triaged).toBe(null)
    expect(one?.asked).toBe('')
  })

  it('is not acted on by work made to wait for its approval', () => {
    const build = event(
      'task_created',
      'app/build',
      { after: ['app/plan'], approval: ['app/plan'] },
      2,
    )
    const other = event('task_created', 'app/docs', { after: ['app/plan'] }, 3)
    const [one] = documentsIn([ready(1), build, other])
    expect(one?.followed).toEqual(['app/docs'])
  })

  it('is approved only by a triage that says so, and until it is asked again', () => {
    expect(approvedFrom([ready(1), triaged(2)]).has('app/plan')).toBe(false)
    const yes = approvedFrom([ready(1), triaged(2, { approved: true, said: 'yes, B' })])
    expect(yes.get('app/plan')).toMatchObject({ by: 'orchestrator', approved: true })
    // Finishing keeps it; handing it over again is a new question.
    expect(approvedFrom([ready(1), triaged(2, { approved: true }), done(3)]).has('app/plan')).toBe(
      true,
    )
    expect(approvedFrom([ready(1), triaged(2, { approved: true }), ready(3)]).has('app/plan')).toBe(
      false,
    )
    expect(
      actedOnSays({ triaged: { by: 'orchestrator', decided: 'B', at: at(2), approved: true } }),
    ).toBe('orchestrator read it and approved it: B')
  })
})
