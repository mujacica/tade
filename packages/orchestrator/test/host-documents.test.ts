import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigSchema, type EventInput, producesPath, type TadeEvent } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { documentMethods } from '../src/host-documents.ts'

// The `ToolHost` methods behind the document tools, against a real home on
// disk and a journal held in memory: what the orchestrator is answered, and
// that a deletion is written down as the orchestrator's on somebody's say-so.

describe('the document methods the orchestrator reaches', () => {
  let home: string
  let lines: TadeEvent[]
  let methods: ReturnType<typeof documentMethods>
  let path: string

  beforeEach(() => {
    home = tmp('tade-host-documents-')
    lines = []
    const append = async (input: EventInput): Promise<TadeEvent> => {
      const line: TadeEvent = {
        seq: lines.length + 1,
        // Now, because the cleanup asks the clock: a decision made a moment
        // ago is never old enough to be cleaned up, whatever day this runs.
        ts: new Date().toISOString(),
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
    const tade = {
      home,
      config: ConfigSchema.parse({}),
      log: { read: async () => [...lines], append },
    }
    methods = documentMethods(tade as unknown as Workbench)
    path = producesPath(home, 'app/audit', 'AUDIT.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# found\n')
    void append({ type: 'task_done', task: 'app/audit', detail: { by: 'agent', produces: path } })
  })

  it('lists what is waiting, and every one when asked for all', async () => {
    expect(await methods['documents/list']?.({})).toContain('nobody has decided about yet')
    expect(await methods['documents/list']?.({ all: true })).toContain('Every document')
  })

  it('writes a decision down, and the cleanup then has nothing it may take yet', async () => {
    const said = await methods['documents/triage']?.({
      task: 'app/audit',
      path,
      decided: 'nothing follows',
    })
    expect(said).toContain('Written down')
    expect(await methods['documents/cleanup']?.({})).toContain('Nothing to clean up')
    expect(await methods['documents/cleanup']?.({ apply: true })).toContain('Nothing to clean up')
    expect(existsSync(path)).toBe(true)
  })

  it('deletes one as the orchestrator, with the reason it was given', async () => {
    expect(
      await methods['documents/delete']?.({ task: 'app/audit', path, why: 'they asked' }),
    ).toContain(`Deleted ${path}`)
    expect(existsSync(path)).toBe(false)
    expect(lines.at(-1)?.detail).toMatchObject({ by: 'orchestrator', explained: 'they asked' })
  })
})
