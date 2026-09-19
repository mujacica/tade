import { testJudge } from '@tade/judges-core/conformance'
import { describe, expect, it } from 'vitest'
import { ScriptedJudge } from '../src/index.ts'

// The judge that asks nobody. It passes the same suite the one that does,
// which is the point of having it: the review loop, the tools and every
// threshold can be exercised offline, and what is under test is Tade rather
// than somebody's model.

testJudge('scripted', () => new ScriptedJudge({ answers: { urgent: 0.9, area: 'payments' } }), {
  refused: () => new ScriptedJudge({ refuse: { status: 429, message: 'too many requests' } }),
})

describe('answering from a table', () => {
  it('answers what it was told, and what it was not with the same number every time', async () => {
    const judge = new ScriptedJudge({ answers: { known: 0.83 }, otherwise: 0.1 })
    const judged = await judge.ask({
      state: 'anything',
      questions: [
        { id: 'known', kind: 'yes-no', ask: 'is it?' },
        { id: 'unknown', kind: 'yes-no', ask: 'or is it?' },
      ],
    })
    expect(judged.answers.known).toEqual({ kind: 'yes-no', probability: 0.83 })
    expect(judged.answers.unknown).toEqual({ kind: 'yes-no', probability: 0.1 })
    expect(judged.cost).toEqual({ requests: 1, inputTokens: null, usd: 0 })
  })

  it('picks a level by its own name, and never one that was not declared', async () => {
    const judge = new ScriptedJudge({
      answers: { severity: 'fix before release', area: 'nowhere' },
    })
    const judged = await judge.ask({
      state: 'a diff',
      questions: [
        {
          id: 'severity',
          kind: 'rate',
          ask: 'how bad?',
          levels: ['nothing to say', 'worth a comment', 'fix before release'],
        },
        { id: 'area', kind: 'pick', ask: 'where?', options: { core: null, app: null } },
      ],
    })
    const severity = judged.answers.severity
    expect(severity?.kind === 'rate' && severity.level).toBe(2)
    const area = judged.answers.area
    expect(area?.kind === 'pick' && area.picked).toBe('core')
  })

  it('needs nothing set up, and says so', () => {
    expect(new ScriptedJudge().ready()).toBeNull()
  })
})
