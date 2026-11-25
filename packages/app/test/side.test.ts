import { heldFor } from '@tade/remotes-core'
import type { Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import type { Target } from '../src/hits.ts'
import { goElsewhere, machineOf } from '../src/machines.ts'
import { initialState, withProjects } from '../src/model.ts'
import { hereTarget, seenThere, thereTarget } from '../src/side.ts'
import { there } from '../src/there.ts'
import { frame, NOW } from './screens/scenarios/fixtures.ts'

// What `side.ts` does between a project there and the views that draw it:
// every target drawn from it carried to its machine, and back for the pointer;
// and a project there whose Tade is too old to answer drawn from what its
// projection says, never from anything of this machine's.

const TASK = 'tade/door'

describe('a press on a project there, carried to its machine', () => {
  const cases: Target[] = [
    { kind: 'task', task: TASK },
    { kind: 'task-menu', task: TASK },
    { kind: 'lane', task: TASK, lane: 'remotes/vps/1' },
    { kind: 'action', name: `close-task:${TASK}` },
    { kind: 'action', name: `model:${TASK}` },
    { kind: 'action', name: `thinking:${TASK}` },
    { kind: 'action', name: `harness:${TASK}` },
    { kind: 'action', name: 'schedule-pause:nightly' },
    { kind: 'menu', subject: { kind: 'task', task: TASK } },
    { kind: 'menu', subject: { kind: 'schedule', id: 'nightly' } },
  ]

  it('carries every id of the project there, and reads it back for the pointer', () => {
    for (const one of cases) {
      const out = thereTarget(one, 'vps')
      expect(JSON.stringify(out), JSON.stringify(one)).toContain(
        JSON.stringify(there('vps', '')).slice(1, -1),
      )
      expect(hereTarget(out, 'vps')).toEqual(one)
    }
  })

  it('makes the card’s answers, opening its agent and opening a request that machine’s', () => {
    const action = (name: string) => thereTarget({ kind: 'action', name }, 'vps')
    expect(action('approve')).toEqual({ kind: 'action', name: 'remote-allow' })
    expect(action('deny')).toEqual({ kind: 'action', name: 'remote-deny' })
    expect(action('open-agent')).toEqual({ kind: 'action', name: 'remote-attach' })
    expect(action('intake-open:github:1')).toEqual({
      kind: 'action',
      name: 'remote-request:vps github:1',
    })
    expect(hereTarget(action('approve'), 'vps')).toEqual({ kind: 'action', name: 'approve' })
  })

  it('leaves what names nothing of the project, and another machine’s ids, as they are', () => {
    const own: Target[] = [
      { kind: 'section', section: 'files' },
      { kind: 'action', name: 'toggle-done' },
      { kind: 'action', name: 'new-agent-where' },
      { kind: 'folder', path: 'src' },
    ]
    for (const one of own) expect(thereTarget(one, 'vps')).toEqual(one)
    const elsewhere: Target = { kind: 'task', task: there('lab', TASK) }
    expect(thereTarget(elsewhere, 'vps')).toEqual(elsewhere)
    expect(hereTarget(elsewhere, 'vps')).toEqual(elsewhere)
  })
})

describe('a project there whose Tade does not answer for its side', () => {
  it('is drawn from its projection, with the header its row says, never this machine’s route', () => {
    const snapshot = {
      v: 1,
      fresh: { at: new Date(NOW).toISOString(), epoch: 'e1', rev: 3 },
      projects: [{ name: 'tade', open: true }],
      tasks: [
        {
          id: TASK,
          project: 'tade',
          name: 'door',
          mark: 'working',
          state: 'working',
          harness: 'claude-code',
          model: 'opus',
          rev: 'r1',
          lane: 'running',
        },
      ],
      queue: [],
    } as unknown as Snapshot
    const held = {
      ...heldFor('vps'),
      link: { kind: 'live' as const, since: NOW },
      heardAt: NOW,
      projection: snapshot,
    }
    const state = goElsewhere(withProjects(initialState(), ['checkout']), {
      machine: 'vps',
      project: 'tade',
      agent: TASK,
    })
    const seen = seenThere(
      state,
      frame({ machines: { here: 'this Mac', remotes: [machineOf(held, 0)] } }),
    )
    expect(seen?.state.project).toBe('tade')
    expect(seen?.state.focused).toBe(TASK)
    expect(seen?.state.panes.map((pane) => pane.task)).toEqual([TASK])
    expect(seen?.frame.route).toMatchObject({ harness: 'claude-code', model: 'opus' })
    expect(seen?.frame.vitals).toBeNull()
    // Of its checkout nothing was said: not looked at, never this machine's.
    expect(seen?.frame.changes).toBeNull()
    expect(seen?.frame.where).toBeNull()
  })

  it('is nothing to stand in where you stand here', () => {
    expect(seenThere(withProjects(initialState(), ['checkout']), frame())).toBeNull()
  })
})
