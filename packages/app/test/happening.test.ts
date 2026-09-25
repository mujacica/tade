import { describe, expect, it } from 'vitest'
import { happeningIn, happeningOn } from '../src/happening.ts'
import type { AgentPane } from '../src/model.ts'

// What is happening, in words: the fold search matches a sentence against and
// puts to whoever reads one. Pure — panes and folds in, lines out.

const pane = (over: Partial<AgentPane> = {}): AgentPane => ({
  task: 'tade/flaky-suite',
  project: 'tade',
  name: 'flaky-suite',
  title: null,
  branch: '',
  lane: null,
  state: 'working',
  waiting: false,
  approval: null,
  lanes: [],
  ...over,
})

describe('what is happening about one piece of work', () => {
  it('says what it is doing and what it was asked for, in the words it was asked in', () => {
    const said = happeningOn(pane({ intent: 'raise test coverage in packages/core' }), {
      doing: 'working · 2 commits, tests green',
      work: null,
    })
    expect(said.split('\n')).toEqual([
      'working · 2 commits, tests green',
      'asked for: raise test coverage in packages/core',
    ])
  })

  it('says what queued work waits on, why, and what its agent will be told', () => {
    const said = happeningOn(
      pane({
        state: 'queued',
        queued: {
          state: { kind: 'held', on: 'tade/ledger', because: 'tade/ledger failed' },
          after: [{ task: 'tade/ledger', why: 'it moves the same files' }],
          prompt: 'Fix the rounding on refunds',
          touches: ['src/ledger.ts'],
          at: null,
        },
      }),
      { doing: 'not started' },
    )
    expect(said).toContain('held: tade/ledger failed')
    expect(said).toContain('waits on tade/ledger because it moves the same files')
    expect(said).toContain('its agent will be told: Fix the rounding on refunds')
    expect(said).toContain('it is expected to change src/ledger.ts')
  })

  it('says how the checks stand at the commit in hand, and says unknown as unknown', () => {
    const said = happeningOn(pane(), {
      doing: 'working',
      checks: { rollup: 'fail', commit: '1a2b3c4d5e6f', failing: ['types', 'tests'] },
    })
    expect(said).toContain('checks at 1a2b3c4: fail')
    expect(said).toContain('failing checks: types, tests')
    const nothing = happeningOn(pane(), {
      doing: 'working',
      checks: { rollup: 'unknown', commit: null, failing: [] },
    })
    expect(nothing).toContain('checks: unknown')
  })

  it('carries a note with the headline written beside it, and cuts a long one saying so', () => {
    const said = happeningOn(pane(), {
      doing: 'working',
      notes: [
        { text: 'the retry path double-charges', summary: 'refunds' },
        { text: `x${'y'.repeat(400)}` },
      ],
    })
    expect(said).toContain('note: refunds — the retry path double-charges')
    expect(said).toContain('…')
  })

  it('says nothing at all about work the journal has nothing on', () => {
    const said = happeningOn(pane(), {
      doing: 'working',
      work: {
        task: 'tade/flaky-suite',
        empty: true,
        turns: 0,
        tools: 0,
        used: [],
        notable: [],
        waiting: null,
        failed: null,
        state: null,
        lastAt: null,
      },
    })
    expect(said).toBe('working')
  })

  it('says what the agent has been up to, and what stopped it', () => {
    const said = happeningOn(pane(), {
      doing: 'working',
      work: {
        task: 'tade/flaky-suite',
        empty: false,
        turns: 4,
        tools: 12,
        used: [
          { tool: 'Edit', count: 7 },
          { tool: 'Bash', count: 5 },
        ],
        notable: ['rm -rf build'],
        waiting: 'npm publish',
        failed: null,
        state: 'working',
        lastAt: 1,
      },
    })
    expect(said).toContain('12 tool calls over 4 turns, mostly Edit, Bash')
    expect(said).toContain('waiting on npm publish')
    expect(said).toContain('it ran rm -rf build')
  })
})

describe('what is happening in a project', () => {
  it('says who is at work in it, and what you have told Tade about it', () => {
    const said = happeningIn('tade', {
      panes: [
        pane(),
        pane({ task: 'tade/ledger', name: 'ledger', state: 'blocked', waiting: true }),
        pane({ project: 'other', task: 'other/x', name: 'x' }),
      ],
      notes: [{ text: 'release is Thursday', summary: 'release' }],
    })
    expect(said.split('\n')).toEqual([
      'working here: flaky-suite',
      'waiting on you: ledger',
      'note: release — release is Thursday',
    ])
  })
})
