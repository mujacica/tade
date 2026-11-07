import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOSE_SETTLE_MS,
  type CloseNow,
  closeFactsFrom,
  closeWaitsOn,
} from '../src/close-when-done.ts'
import { type Config, ConfigSchema } from '../src/config.ts'
import { parseConfig, writeSetting } from '../src/config-file.ts'
import type { TadeEvent } from '../src/events.ts'
import { closeWhenDoneFor } from '../src/project.ts'
import { parseSetting, settingsOf } from '../src/settings.ts'

// When a finished agent's lane may close: on the journal's word and never on
// how it looks, and never while it is still saying something.

const T = 'app/refunds'
const AT = Date.parse('2026-11-07T10:00:00.000Z')

let seq = 0
const line = (type: string, detail: Record<string, unknown> = {}, task = T): TadeEvent =>
  ({
    seq: ++seq,
    ts: new Date(AT + seq).toISOString(),
    type,
    task,
    run: null,
    lane: null,
    urgency: 'notable',
    detail,
  }) as unknown as TadeEvent

const facts = (...lines: TadeEvent[]) =>
  closeFactsFrom(lines).get(T) ?? { done: null, turn: 'unknown' as const, quietSince: 0 }

/** Everything clear, long enough after: what each case then takes away. */
const clear: CloseNow = {
  now: AT + 60_000,
  turn: 'unknown',
  approval: false,
  lost: false,
  told: true,
  looking: false,
}

describe('what a close waits on', () => {
  it('closes a task the journal says finished, once its turn has ended', () => {
    const ended = facts(line('turn_started'), line('task_done'), line('turn_done'))
    expect(closeWaitsOn(ended, clear)).toBeNull()
  })

  it('never closes one mid-turn, on either the journal’s word or its run’s', () => {
    // `tade_done` is a tool call: the line is written with the turn still open.
    const midTurn = facts(line('turn_started'), line('task_done'))
    expect(closeWaitsOn(midTurn, clear)).toBe('turn')
    expect(closeWaitsOn(midTurn, { ...clear, turn: 'idle' })).toBe('turn')
    const ended = facts(line('turn_started'), line('task_done'), line('turn_done'))
    expect(closeWaitsOn(ended, { ...clear, turn: 'running' })).toBe('turn')
  })

  it('does not guess at a turn nothing has said anything about', () => {
    expect(closeWaitsOn(facts(line('task_done')), clear)).toBe('turn')
    expect(closeWaitsOn(facts(line('task_done')), { ...clear, turn: 'idle' })).toBeNull()
  })

  it('leaves open what never finished: a turn ending and a question are not finishing', () => {
    expect(closeWaitsOn(facts(line('turn_started'), line('turn_done')), clear)).toBe('finished')
    const asked = facts(line('turn_done'), line('document_ready', { asked: 'A or B?' }))
    expect(closeWaitsOn(asked, clear)).toBe('finished')
  })

  it('takes a question asked after finishing as work that is not finished after all', () => {
    const askedAfter = facts(line('task_done'), line('document_ready', { asked: 'A or B?' }))
    expect(closeWaitsOn(askedAfter, clear)).toBe('finished')
    // A draft it carries on past is not somebody being waited on.
    const draft = facts(
      line('turn_done'),
      line('task_done'),
      line('document_ready', { waits: false }),
    )
    expect(closeWaitsOn(draft, clear)).toBeNull()
  })

  it('waits for the orchestrator to have what it reported, before anything else', () => {
    const ended = facts(line('task_done'), line('turn_done'))
    expect(closeWaitsOn(ended, { ...clear, told: false })).toBe('report')
    expect(closeWaitsOn(ended, { ...clear, told: false, lost: true })).toBe('report')
  })

  it('leaves what arrives behind a turn’s last word the moment it needs', () => {
    const ended = facts(line('task_done'), line('turn_done'))
    const quiet = ended.quietSince
    expect(closeWaitsOn(ended, { ...clear, now: quiet + CLOSE_SETTLE_MS - 1 })).toBe('settling')
    expect(closeWaitsOn(ended, { ...clear, now: quiet + CLOSE_SETTLE_MS })).toBeNull()
  })

  it('leaves alone one waiting on an approval, and one somebody has in front of them', () => {
    const ended = facts(line('task_done'), line('turn_done'))
    expect(closeWaitsOn(ended, { ...clear, approval: true })).toBe('approval')
    expect(closeWaitsOn(ended, { ...clear, looking: true })).toBe('looking')
  })

  it('has no turn to wait for where its process went with the window', () => {
    const cut = facts(line('turn_started'), line('task_done'))
    expect(closeWaitsOn(cut, { ...clear, lost: true, looking: true })).toBeNull()
  })

  it('owes one close per finishing, so opening an agent again is not undone', () => {
    const closed = facts(line('task_done'), line('turn_done'), line('agent_closed'))
    expect(closeWaitsOn(closed, clear)).toBe('finished')
    const reopened = facts(
      line('task_done'),
      line('turn_done'),
      line('run_started'),
      line('turn_done'),
    )
    expect(closeWaitsOn(reopened, clear)).toBe('finished')
    const again = facts(
      line('task_done'),
      line('run_started'),
      line('task_done'),
      line('turn_done'),
    )
    expect(closeWaitsOn(again, clear)).toBeNull()
    expect(closeWaitsOn(facts(line('task_done'), line('task_removed')), clear)).toBe('finished')
  })

  it('reads only its own lines, and only that task’s', () => {
    const other = closeFactsFrom([line('task_done', {}, 'app/other'), line('said', {})])
    expect(other.has(T)).toBe(false)
    expect(other.get('app/other')?.done?.type).toBe('task_done')
  })
})

describe('who says so', () => {
  const config = (agents: unknown, project: unknown): Config =>
    ConfigSchema.parse({ agents, projects: { app: { root: '/tmp/app', ...(project as object) } } })

  it('is off unless somebody says, the project’s word over the machine’s', () => {
    expect(closeWhenDoneFor(config({}, {}), 'app')).toBe(false)
    expect(closeWhenDoneFor(config({ close_when_done: true }, {}), 'app')).toBe(true)
    expect(
      closeWhenDoneFor(config({ close_when_done: true }, { close_when_done: 'off' }), 'app'),
    ).toBe(false)
    expect(closeWhenDoneFor(config({}, { close_when_done: 'on' }), 'app')).toBe(true)
    expect(closeWhenDoneFor(config({ close_when_done: true }, {}), null)).toBe(true)
  })

  it('is written by the one path every door uses, and the schema refuses a bad value', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tade-close-')), 'config.yaml')
    writeFileSync(file, 'projects:\n  app:\n    root: /tmp/app\n')
    const read = () => {
      const parsed = parseConfig(readFileSync(file, 'utf8'))
      if (!parsed.ok) throw new Error(parsed.issues[0]?.message)
      return parsed.config
    }
    const write = (path: string, said: string) => {
      const row = settingsOf(read())
        .flatMap((group) => group.settings)
        .find((one) => one.path === path)
      if (!row) throw new Error(`no row for ${path}`)
      writeSetting(file, path, parseSetting(row, said))
    }
    write('agents.close_when_done', 'true')
    expect(closeWhenDoneFor(read(), 'app')).toBe(true)
    write('projects.app.close_when_done', 'off')
    expect(closeWhenDoneFor(read(), 'app')).toBe(false)
    // Empty goes back to following the machine, and the key leaves the file.
    write('projects.app.close_when_done', '')
    expect(closeWhenDoneFor(read(), 'app')).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('close_when_done: off')
    // Refused by the schema, naming the key: the page and the CLI put it back as it was.
    write('projects.app.close_when_done', 'maybe')
    const bad = parseConfig(readFileSync(file, 'utf8'))
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues[0]?.path).toBe('projects.app.close_when_done')
  })
})
