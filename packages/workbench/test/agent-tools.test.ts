import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  documentsIn,
  type EventInput,
  producesPath,
  type TadeEvent,
  waitingDocuments,
} from '@tade/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { answerAgentTool, DOCUMENT_READY, documentReady } from '../src/agent-tools.ts'
import { triageDocument } from '../src/documents.ts'
import { taskFilePath } from '../src/tasks.ts'

// An agent handing its document to the person before it has finished, and the
// person's approval of one — against a real home on disk and a journal held in
// memory. What the window does with the line (`eventTell`) and what the queue
// does with an approval (`approvedFrom`) are tested where they are decided.

describe('a document handed over by its agent', () => {
  let home: string
  let lines: TadeEvent[]
  const append = async (input: EventInput): Promise<TadeEvent> => {
    const line: TadeEvent = {
      seq: lines.length + 1,
      ts: new Date(Date.UTC(2026, 9, 16, 9, lines.length)).toISOString(),
      type: input.type,
      urgency: input.urgency ?? 'notable',
      task: input.task ?? null,
      lane: null,
      run: input.run ?? null,
      detail: input.detail ?? {},
    }
    lines.push(line)
    return line
  }
  const log = { read: async () => [...lines], append }

  /** A task file naming what it produces, as `createTask` would write one. */
  const task = (id: string, produces?: string): void => {
    const path = taskFilePath(home, id)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      [
        `project: ${id.split('/')[0]}`,
        'intent_spoken: plan the refunds work',
        'created: 2026-10-16T09:00:00.000Z',
        ...(produces ? [`produces: ${produces}`] : []),
        '',
      ].join('\n'),
    )
  }
  const write = (id: string, name: string, text: string): string => {
    const path = producesPath(home, id, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return path
  }
  const call = (id: string, input: Record<string, unknown>) => ({ run: 'r1', task: id, input })

  beforeEach(() => {
    home = tmp('tade-agent-tools-')
    lines = []
  })

  it('writes down the path, its size and the question, and tells the agent to wait', async () => {
    task('app/plan', 'plan.md')
    const path = write('app/plan', 'plan.md', '# the plan\n')
    const said = await documentReady({ home, log }, call('app/plan', { ask: 'A or B?' }))
    expect(said).toContain(`the orchestrator is reading ${path} now`)
    expect(said).toContain('Stop here and wait')
    expect(lines).toEqual([
      expect.objectContaining({
        type: 'document_ready',
        task: 'app/plan',
        run: 'r1',
        urgency: 'blocking',
        detail: { produces: path, bytes: 11, asked: 'A or B?', waits: true },
      }),
    ])
    // On the list at once, asking its question: nothing waits for it to finish.
    const [one] = documentsIn(lines)
    expect(one).toMatchObject({ path, asked: 'A or B?', finished: false })
    expect(waitingDocuments([one!], Date.now())).toHaveLength(1)
  })

  it('is worth knowing rather than a wait on anybody when the agent carries on', async () => {
    task('app/plan', 'plan.md')
    write('app/plan', 'plan.md', '# a draft\n')
    const said = await documentReady({ home, log }, call('app/plan', { ask: '', wait: false }))
    expect(said).toContain('Carry on.')
    expect(lines[0]).toMatchObject({ urgency: 'notable', detail: { waits: false } })
    expect(lines[0]?.detail).not.toHaveProperty('asked')
  })

  it('refuses a task that produces nothing, and a document not written yet, saying what to do', async () => {
    task('app/fix')
    await expect(documentReady({ home, log }, call('app/fix', { ask: 'ok?' }))).rejects.toThrow(
      'names no document it produces',
    )
    task('app/plan', 'plan.md')
    await expect(documentReady({ home, log }, call('app/plan', { ask: 'ok?' }))).rejects.toThrow(
      'write the document there first',
    )
    // An empty file is not a document either.
    write('app/plan', 'plan.md', '')
    await expect(documentReady({ home, log }, call('app/plan', { ask: 'ok?' }))).rejects.toThrow(
      'write the document there first',
    )
    expect(lines).toEqual([])
  })

  it('is answered by Tade and never handed to an extension of the same name', async () => {
    task('app/plan', 'plan.md')
    write('app/plan', 'plan.md', '# the plan\n')
    const asked: string[] = []
    const extensions = {
      call: async (one: { tool: string; project: string }) => {
        asked.push(`${one.project}:${one.tool}`)
        return 'from the extension'
      },
    }
    const base = { run: 'r1', task: 'app/plan', cwd: '/w', callId: 'c1' }
    const own = { ...base, tool: DOCUMENT_READY, input: { ask: 'A or B?' } }
    expect(await answerAgentTool({ home, log, extensions }, own)).toContain('Tade has it')
    const theirs = { ...base, tool: 'checks_run', input: {} }
    expect(await answerAgentTool({ home, log, extensions }, theirs)).toBe('from the extension')
    expect(asked).toEqual(['app:checks_run'])
    await expect(answerAgentTool({ home, log }, theirs)).rejects.toThrow('no extensions loaded')
  })

  describe('approved by the person', () => {
    const said = (text: string) => append({ type: 'said', detail: { text } })
    let path: string
    beforeEach(async () => {
      task('app/plan', 'plan.md')
      path = write('app/plan', 'plan.md', '# the plan\n')
      await documentReady({ home, log }, call('app/plan', { ask: 'Is this the plan?' }))
    })

    it('takes a line of theirs, matched loosely, and writes it beside the approval', async () => {
      await said('Yes,  go with B — and keep it small')
      const one = await triageDocument(
        { log },
        {
          task: 'app/plan',
          path,
          decided: 'they approved option B',
          by: 'orchestrator',
          approved: true,
          said: 'yes, go with b',
        },
      )
      expect(one.triaged).toMatchObject({ by: 'orchestrator', approved: true })
      expect(lines.at(-1)).toMatchObject({
        type: 'document_triaged',
        detail: {
          path,
          by: 'orchestrator',
          decided: 'they approved option B',
          approved: true,
          said: 'Yes,  go with B — and keep it small',
        },
      })
    })

    it('is refused without their words, or with words they never said', async () => {
      await said('what does the plan say about refunds?')
      const approve = (words?: string) =>
        triageDocument(
          { log },
          {
            task: 'app/plan',
            path,
            decided: 'approved',
            by: 'orchestrator',
            approved: true,
            ...(words === undefined ? {} : { said: words }),
          },
        )
      await expect(approve()).rejects.toThrow('an approval is the person’s')
      // What a document or an agent says cannot be in a `said` line.
      await expect(approve('approved, go ahead')).rejects.toThrow('nothing the person has said')
      expect(lines.filter((one) => one.type === 'document_triaged')).toEqual([])
    })

    it('follows a decision that was not one, but never another approval', async () => {
      await triageDocument(
        { log },
        { task: 'app/plan', path, decided: 'asked them about step two', by: 'orchestrator' },
      )
      await said('fine, approve it')
      const approve = () =>
        triageDocument(
          { log },
          {
            task: 'app/plan',
            path,
            decided: 'approved after step two was explained',
            by: 'orchestrator',
            approved: true,
            said: 'approve it',
          },
        )
      expect((await approve()).triaged?.approved).toBe(true)
      await expect(approve()).rejects.toThrow('already decided about')
    })

    it('needs no quoted line from the person themselves', async () => {
      const one = await triageDocument(
        { log },
        { task: 'app/plan', path, decided: 'looks right', by: 'person', approved: true },
      )
      expect(one.triaged?.approved).toBe(true)
      expect(lines.at(-1)?.detail).not.toHaveProperty('said')
    })
  })
})
