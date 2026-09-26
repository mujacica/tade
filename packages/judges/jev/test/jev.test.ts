import { JudgeError } from '@tade/judges-core'
import { testJudge } from '@tade/judges-core/conformance'
import { describe, expect, it } from 'vitest'
import { JevJudge, jevVersions } from '../src/index.ts'

// TypeSafe, answered here the way their API answers. Nothing reaches the
// network: what is under test is what Tade sends and what it makes of what
// comes back — not whether Jev is any good, which is not a property of this
// file.

interface Asked {
  state: unknown
  model?: unknown
  questions: Record<string, { type?: string; instructions?: string; criteria?: unknown }>
}

/** A TypeSafe that answers every question it is asked, plausibly. */
function typesafe(
  answer: (id: string, asked: Asked['questions'][string]) => Record<string, unknown>,
  seen?: Asked[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return Response.json({ data: [{ id: 'jev-1.13.0' }, { id: 'jev-latest' }] })
    }
    const body = JSON.parse(String(init?.body)) as Asked
    seen?.push(body)
    return Response.json({
      model: 'jev-1.13.0',
      usage: { input_tokens: 1_000 },
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => [id, answer(id, question)]),
      ),
    })
  }) as typeof fetch
}

const plausible = (_id: string, question: { type?: string; criteria?: unknown }) => {
  if (question.type === 'noul') return { type: 'noul', noul: 0.72 }
  if (question.type === 'choice') {
    const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
    return {
      type: 'choice',
      choice: options[0],
      probabilities: Object.fromEntries(
        options.map((option, index) => [option, index === 0 ? 0.8 : 0.1]),
      ),
      confidence: 0.77,
    }
  }
  const levels = (question.criteria ?? []) as string[]
  return {
    type: 'score',
    score: 1.4,
    legend: levels,
    probabilities: Object.fromEntries(levels.map((level) => [level, 1 / levels.length])),
    confidence: 0.5,
  }
}

testJudge('jev', () => new JevJudge({ key: 'k', fetch: typesafe(plausible), retryMs: 0 }), {
  refused: () =>
    new JevJudge({
      key: 'k',
      retries: 1,
      retryMs: 0,
      fetch: (async () => new Response('slow down', { status: 429 })) as typeof fetch,
    }),
  unset: () => new JevJudge({}),
})

describe('asking TypeSafe', () => {
  it('says each kind of question in their words, and nobody else says them', async () => {
    const seen: Asked[] = []
    const judge = new JevJudge({ key: 'k', fetch: typesafe(plausible, seen), retryMs: 0 })
    await judge.ask({
      state: { diff: 'a patch' },
      questions: [
        {
          id: 'authz_removed',
          kind: 'yes-no',
          ask: 'Does this weaken a permission check?',
          means: { yes: 'it does', no: 'it does not' },
        },
        {
          id: 'area',
          kind: 'pick',
          ask: 'Which part?',
          options: { core: 'the domain', app: null },
        },
        { id: 'severity', kind: 'rate', ask: 'How bad?', levels: ['fine', 'bad'] },
      ],
    })
    const sent = seen[0]
    expect(sent?.model).toBe('jev-1.13.0')
    expect(sent?.state).toBe('{"diff":"a patch"}')
    expect(sent?.questions.authz_removed).toEqual({
      type: 'noul',
      instructions: 'Does this weaken a permission check? Yes means it does. No means it does not.',
    })
    expect(sent?.questions.area).toEqual({
      type: 'choice',
      instructions: 'Which part?',
      criteria: { core: 'the domain', app: 'app' },
    })
    expect(sent?.questions.severity).toEqual({
      type: 'score',
      instructions: 'How bad?',
      criteria: ['fine', 'bad'],
    })
  })

  it('keeps the version that answered, and what it cost', async () => {
    const judge = new JevJudge({ key: 'k', fetch: typesafe(plausible), retryMs: 0 })
    const judged = await judge.ask({
      state: 'x',
      questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }],
    })
    expect(judged.version).toBe('jev-1.13.0')
    expect(judged.cost.inputTokens).toBe(1_000)
    expect(judged.cost.usd).toBeCloseTo(0.000042, 9)
  })

  it('never hands back an option nobody declared', async () => {
    const judge = new JevJudge({
      key: 'k',
      retryMs: 0,
      fetch: typesafe(() => ({
        type: 'choice',
        choice: 'somewhere else',
        probabilities: { core: 0.2, app: 0.7 },
        confidence: 0.4,
      })),
    })
    const judged = await judge.ask({
      state: 'x',
      questions: [{ id: 'area', kind: 'pick', ask: 'which?', options: { core: null, app: null } }],
    })
    const area = judged.answers.area
    expect(area?.kind === 'pick' && area.picked).toBe('app')
  })

  it('treats a question it did not answer as broken, not as a zero', async () => {
    const judge = new JevJudge({
      key: 'k',
      retryMs: 0,
      fetch: (async () => Response.json({ model: 'jev-1.13.0', answers: {} })) as typeof fetch,
    })
    await expect(
      judge.ask({ state: 'x', questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }] }),
    ).rejects.toThrow(/did not answer one/)
  })

  it('says what a refusal was, and whether asking again could work', async () => {
    const cases: [number, RegExp, boolean][] = [
      [401, /key was not accepted/, false],
      [422, /would not do/, false],
      [429, /too many requests/, true],
      [529, /overloaded/, true],
    ]
    for (const [status, says, retryable] of cases) {
      const judge = new JevJudge({
        key: 'k',
        retries: 0,
        retryMs: 0,
        fetch: (async () => new Response('the body said something', { status })) as typeof fetch,
      })
      const failed = await judge
        .ask({ state: 'x', questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }] })
        .then(() => null)
        .catch((err: unknown) => err as JudgeError)
      expect(failed).toBeInstanceOf(JudgeError)
      expect(failed?.message).toMatch(says)
      expect(failed?.status).toBe(status)
      expect(failed?.retryable).toBe(retryable)
    }
  })

  it('says a state that was too long in words, and does not ask again with the same one', async () => {
    let asked = 0
    const judge = new JevJudge({
      key: 'k',
      retries: 2,
      retryMs: 0,
      fetch: (async () => {
        asked++
        // What they actually answer, and what reached somebody as the whole of
        // why a review did not happen: one red line with this JSON in it.
        return new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })
      }) as typeof fetch,
    })
    const failed = await judge
      .ask({ state: 'x', questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }] })
      .then(() => null)
      .catch((err: unknown) => err as JudgeError)
    expect(failed?.message).toMatch(/longer than one ask takes.*read it in pieces/)
    expect(failed?.message).not.toMatch(/error_type|detail|[{}]/)
    // Asking the same thing again cannot make it shorter.
    expect(failed?.retryable).toBe(false)
    expect(asked).toBe(1)
    // And it is said as a fact and not only in the sentence: what a caller does
    // about this refusal is ask for less, and nothing should have to read prose
    // to know that this is the one refusal with a move in it.
    expect(failed?.tooBig).toBe(true)
  })

  it('asks again when told to come back, and gives up saying why', async () => {
    let attempts = 0
    const judge = new JevJudge({
      key: 'k',
      retries: 2,
      retryMs: 0,
      fetch: (async () => {
        attempts++
        return attempts < 3
          ? new Response('busy', { status: 529 })
          : Response.json({ model: 'jev-1.13.0', answers: { one: { type: 'noul', noul: 0.4 } } })
      }) as typeof fetch,
    })
    const judged = await judge.ask({
      state: 'x',
      questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }],
    })
    expect(attempts).toBe(3)
    expect(judged.answers.one).toEqual({ kind: 'yes-no', probability: 0.4 })
  })

  it('refuses to ask at all without a key, and touches nothing to find that out', async () => {
    const judge = new JevJudge({
      fetch: (async () => {
        throw new Error('it reached the network')
      }) as typeof fetch,
    })
    expect(judge.ready()).toMatch(/TYPESAFE_API_KEY/)
    await expect(
      judge.ask({ state: 'x', questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }] }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/)
  })

  it('lists the versions a key can ask, when somebody asks for them', async () => {
    expect(await jevVersions({ key: 'k', fetch: typesafe(plausible) })).toEqual([
      'jev-1.13.0',
      'jev-latest',
    ])
  })
})
