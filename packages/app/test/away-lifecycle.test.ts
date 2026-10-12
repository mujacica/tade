import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  aboutRoot,
  agentLaneOf,
  closedIn,
  projectAble,
  projectLines,
} from '../src/away-lifecycle.ts'

// What the lifecycle verbs read, asked as a table: the journal's lines about
// where a project lives, and a task's own agent lane.
//
// Pure, so every shape a line can arrive in is one row here rather than a
// request somebody remembered to make — and these are the same two functions
// the projection reads on a beat and the window's door reads at the act, so a
// row here is a promise about both.

let seq = 0

/** One `config_changed` line, as the journal holds one. */
function changed(detail: Record<string, unknown>): TadeEvent {
  seq++
  return {
    seq,
    ts: '2026-10-11T12:00:00.000Z',
    type: 'config_changed',
    urgency: 'notable',
    task: null,
    lane: null,
    run: null,
    detail,
  } as unknown as TadeEvent
}

const OPENED = { path: 'projects.app.root', was: '', now: '~/src/app', by: 'window' }
const CLOSED = {
  path: 'projects.app.root',
  was: '~/src/app',
  now: '',
  by: 'device 00112233445566aa',
}

describe('where each project lives, as the journal says', () => {
  it('counts every line about a root, and reads the last one for whether it closed', () => {
    const lines = projectLines([changed(OPENED), changed(CLOSED)])
    expect(lines.get('app')).toEqual({ changes: 2, closedFrom: '~/src/app' })
    const again = projectLines([changed(OPENED), changed(CLOSED), changed(OPENED)])
    // Open again: nothing to put back, and the count is the generation.
    expect(again.get('app')).toEqual({ changes: 3, closedFrom: null })
  })

  it('counts a move as a change and never as a close', () => {
    const moved = { path: 'projects.app.root', was: '~/src/app', now: '~/work/app' }
    expect(projectLines([changed(moved)]).get('app')).toEqual({ changes: 1, closedFrom: null })
  })

  it('reads nothing but the one setting that says where a project lives', () => {
    // Its title, its whole block, another key with `root` in it, and a name
    // the config would refuse: none of them is a line about where it lives.
    const lines = projectLines([
      changed({ path: 'projects.app.title', was: 'App', now: '' }),
      changed({ path: 'projects.app', was: '~/src/app', now: '' }),
      changed({ path: 'projects.app.root.extra', was: '~/src/app', now: '' }),
      changed({ path: 'projects.App.root', was: '~/src/app', now: '' }),
      changed({ path: 'agents.root', was: '~/src/app', now: '' }),
      { ...changed(CLOSED), type: 'task_done' } as TadeEvent,
    ])
    expect([...lines]).toEqual([])
  })

  it('counts a line whose values are not strings, and reads it as saying nothing', () => {
    // Somebody else wrote it: counted, because it is a line about where the
    // project lives and the generation must move, and never read as a close.
    const odd = projectLines([changed({ path: 'projects.app.root', was: 42, now: null })])
    expect(odd.get('app')).toEqual({ changes: 1, closedFrom: null })
    expect(projectLines([changed({ path: 7 })])).toEqual(new Map())
    expect(
      projectLines([{ ...changed(CLOSED), detail: undefined } as unknown as TadeEvent]),
    ).toEqual(new Map())
  })

  it('keeps for the whole journal only the lines it reads', () => {
    expect(aboutRoot(changed(CLOSED))).toBe(true)
    expect(aboutRoot(changed({ path: 'projects.app.title' }))).toBe(false)
    expect(aboutRoot({ ...changed(CLOSED), type: 'lane_closed' } as TadeEvent)).toBe(false)
  })
})

describe('the projects that may be opened again', () => {
  it('are the closed ones the world does not list, by name and count and never where they were', () => {
    const lines = projectLines([changed(OPENED), changed(CLOSED)])
    const rows = closedIn(lines, new Set())
    expect(rows).toEqual([
      {
        name: 'app',
        title: '',
        open: false,
        changes: 2,
        can: [{ verb: 'open', how: 'now' }],
        cannot: [{ verb: 'close', why: 'it is already closed' }],
      },
    ])
    expect(JSON.stringify(rows)).not.toContain('~/src/app')
    // A project the last look still lists is open, whatever a line says since.
    expect(closedIn(lines, new Set(['app']))).toEqual([])
  })

  it('offers exactly one of the two on every project, with the reason for the other', () => {
    for (const open of [true, false]) {
      const made = projectAble(open)
      const named = [...made.can, ...made.cannot].map((one) => one.verb).sort()
      expect(named).toEqual(['close', 'open'])
      for (const one of made.cannot) expect(one.why.length).toBeGreaterThan(5)
    }
  })
})

describe('a task’s own agent lane', () => {
  it('is its `<task>/agent` lane and nothing else', () => {
    const id = 'app/refunds'
    expect(agentLaneOf({ id, lanes: [] })).toBe('none')
    expect(agentLaneOf({ id, lanes: [{ id: `${id}/agent`, alive: true }] })).toBe('running')
    expect(agentLaneOf({ id, lanes: [{ id: `${id}/agent`, alive: false }] })).toBe('stopped')
    // A terminal beside it says nothing about the agent, and another task's
    // agent is another task's.
    expect(agentLaneOf({ id, lanes: [{ id: `${id}/shell`, alive: true }] })).toBe('none')
    expect(agentLaneOf({ id, lanes: [{ id: 'app/refunds-2/agent', alive: true }] })).toBe('none')
  })
})
