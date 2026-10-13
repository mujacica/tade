import { type AgentMark, IDLE_REASON, type Task, type TaskState, type Workspace } from '@tade/core'
import { projector, reachOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { AGENT_MARKS as PAGE_MARKS, rowMark } from '../../../web/src/assets/glyphs.js'
import { awayCollections } from '../../src/away.ts'
import { MARK_TONES, markGlyph } from '../../src/model.ts'
import { type Beatable, beatParts } from '../../src/wire/web-beat.ts'

// **What a phone draws beside an agent is what the window draws beside it.**
// The away view used to draw `deriveState`'s state, and fold `finished` out of
// the last five hundred journal lines: an agent that said it was done an hour
// ago, idle at its prompt, was `blocked` there — a violet `◆` among the work
// wanting you — while the window drew it `✓`. These hold the one rule
// (`markOf`) across the wire, and the page's drawing of it to the window's.

const NOW = Date.parse('2026-10-12T22:30:00.000Z')

function taskAt(id: string, state: TaskState, reason: string): Task {
  return {
    id,
    project: 'app',
    branch: `tade/${id}`,
    worktree: '/nowhere',
    created: new Date(NOW - 3_600_000).toISOString(),
    state,
    reason,
    stalled: false,
    git: null,
    agents: [],
    lanes: [],
  } as unknown as Task
}

function worldOf(tasks: readonly Task[]): Workspace {
  return {
    generatedAt: new Date(NOW).toISOString(),
    projects: [{ name: 'app', root: '/nowhere', brief: null, untracked: [], tasks: [...tasks] }],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as unknown as Workspace
}

/** A window whose recent journal has nothing in it and whose whole-journal folds say `finished`. */
function held(finished: readonly string[], marks?: ReadonlyMap<string, AgentMark>): Beatable {
  return {
    events: [],
    rootLines: [],
    pending: [],
    seenActions: () => null,
    spendToday: () => ({ byTask: {} }),
    queued: [],
    queueFacts: () => ({
      tasks: new Map(),
      finished: new Map(
        finished.map((task) => [
          task,
          { at: new Date(NOW).toISOString(), by: 'agent', summary: 'done' },
        ]),
      ),
      events: [],
      now: NOW,
    }),
    notes: () => [],
    plans: [],
    titles: {},
    tasks: [],
    ...(marks === undefined ? {} : { marks }),
    machineUpSince: null,
    spendSince: null,
  }
}

const notSteerable = () => ({ how: null, why: 'nothing here' })

function rows(world: Workspace, live: Beatable) {
  const made = awayCollections(beatParts(live, world, notSteerable))
  const reach = reachOf({ id: 'aaaaaaaaaaaaaaaa', projects: null, granted: [] })
  const lifetime = { epoch: 'e', rev: 0, openedAt: NOW }
  return projector({ ...made, talk: null, reach, lifetime }, NOW).snapshot().tasks
}

describe('an agent’s state on the away view', () => {
  it('is done when the journal says so, however long ago, and never wants you', () => {
    const world = worldOf([
      taskAt('app/finished', 'blocked', IDLE_REASON),
      taskAt('app/idle', 'blocked', IDLE_REASON),
      taskAt('app/stuck', 'blocked', 'turn ended with 2 uncommitted files'),
      taskAt('app/working', 'working', 'turning'),
      taskAt('app/review', 'review', 'review open'),
    ])
    // `task_done` is in no recent line — only the whole journal's fold has it.
    const by = new Map(rows(world, held(['app/finished'])).map((row) => [row.id, row]))
    expect(by.get('app/finished')?.mark).toBe('done')
    expect(by.get('app/finished')?.finished).toBe(true)
    expect(by.get('app/finished')?.wantsYou).toBe(false)
    expect(by.get('app/idle')?.mark).toBe('idle')
    expect(by.get('app/stuck')?.mark).toBe('needs-you')
    expect(by.get('app/stuck')?.wantsYou).toBe(true)
    expect(by.get('app/working')?.mark).toBe('working')
    expect(by.get('app/review')?.mark).toBe('done')
    // `deriveState`'s answer is still carried as itself, and drawn by nothing.
    expect(by.get('app/finished')?.state).toBe('blocked')
  })

  it('is the window’s own mark where the window drew one', () => {
    const world = worldOf([taskAt('app/held', 'queued', 'waiting to start')])
    // Held queued work is a decision nobody has made: the window's pane knows
    // that and the bare task does not, so the window's answer is the one carried.
    const marks = new Map<string, AgentMark>([['app/held', 'needs-you']])
    const [row] = rows(world, held([], marks))
    expect(row?.mark).toBe('needs-you')
    expect(row?.wantsYou).toBe(true)
  })

  it('is drawn with the window’s glyph and tone for every mark', () => {
    const tones = {
      busy: 't-working',
      hint: 't-quiet',
      waiting: 't-wants',
      bad: 't-failed',
      done: 't-done',
    }
    for (const [mark, tone] of Object.entries(MARK_TONES)) {
      const page = PAGE_MARKS[mark]
      expect(page, mark).toBeDefined()
      expect(page?.tone, mark).toBe(tones[tone])
      // The window turns a spinner for working; every other shape is the same.
      if (mark !== 'working') expect(page?.glyph, mark).toBe(markGlyph(mark as AgentMark))
    }
    expect(Object.keys(PAGE_MARKS).sort()).toEqual(Object.keys(MARK_TONES).sort())
    // A row from a window that predates the field still draws its state.
    expect(rowMark({ state: 'failed' }).word).toBe('failed')
    expect(rowMark({ state: 'blocked', mark: 'done' }).word).toBe('done')
  })
})
