import { describe, expect, it } from 'vitest'
import { stateTokens } from './ask.ts'
import { type Judge, JudgeError, type Question } from './port.ts'

// The shared suite every Judge must pass, written before either
// implementation. Like the driver and voice suites, it asserts nothing about
// whether an answer is *right* — that is a property of a model, not of an
// interface, and a test that asserted it would fail the day somebody changed
// version. What it asserts is the contract around the answer: that every
// question gets one under its own id, that no answer names anything that was
// not declared, that a question or a state it will not take is refused with a
// sentence rather than quietly answered about something else, and that a
// refusal somebody could retry says so.
//
// Nothing here reaches the network: an implementation that talks to somebody
// is given something that answers like them.

export interface JudgeConformanceOptions {
  /**
   * A judge that will be refused by whatever answers it — rate limited,
   * overloaded, offline. Without one, the retryable path is not asserted.
   */
  refused?: () => Judge | Promise<Judge>
  /** A judge with nothing set up, for the sentence `ready()` gives. */
  unset?: () => Judge | Promise<Judge>
}

const YES_NO: Question = {
  id: 'urgent',
  kind: 'yes-no',
  ask: 'Does this say that something is broken right now?',
}

const PICK: Question = {
  id: 'area',
  kind: 'pick',
  ask: 'Which part of the system does this concern?',
  options: { payments: 'money in and out', search: 'finding things', other: null },
}

const RATE: Question = {
  id: 'severity',
  kind: 'rate',
  ask: 'How bad would it be to leave this as it is?',
  levels: ['nothing to say', 'worth a comment', 'fix before release', 'must not ship'],
}

export function testJudge(
  name: string,
  make: () => Judge | Promise<Judge>,
  options: JudgeConformanceOptions = {},
): void {
  describe(`Judge: ${name}`, () => {
    it('declares an id and a full capability set', async () => {
      const judge = await make()
      expect(judge.id).toBeTruthy()
      const can = judge.capabilities
      expect(typeof can.confidence).toBe('boolean')
      expect(typeof can.remote).toBe('boolean')
      for (const key of ['questionsPerAsk', 'stateTokens', 'optionsPerQuestion'] as const) {
        expect(can[key]).toBeGreaterThan(0)
      }
    })

    it('says whether it can answer here without asking anybody', async () => {
      const judge = await make()
      expect(judge.ready()).toBeNull()
      if (options.unset) {
        const problem = (await options.unset()).ready()
        expect(typeof problem).toBe('string')
        expect(problem).toBeTruthy()
      }
    })

    it('can be asked whether what it needs actually works', async () => {
      expect(await (await make()).verify()).toBeNull()
      // Nothing set up is a sentence, not a throw: this is shown to a person.
      if (options.unset) expect(await (await options.unset()).verify()).toBeTruthy()
    })

    it('answers every question under its own id, and invents none', async () => {
      const judge = await make()
      const judged = await judge.ask({
        state: 'payouts have failed for three days',
        questions: [YES_NO, PICK, RATE],
      })
      expect(judged.version).toBeTruthy()
      expect(Object.keys(judged.answers).sort()).toEqual(['area', 'severity', 'urgent'])
      expect(judged.cost.requests).toBeGreaterThan(0)
    })

    it('answers a yes-no with a probability, and a pick with an option that was declared', async () => {
      const judge = await make()
      const judged = await judge.ask({ state: 'a refund failed', questions: [YES_NO, PICK] })
      const yesNo = judged.answers.urgent
      expect(yesNo?.kind).toBe('yes-no')
      if (yesNo?.kind === 'yes-no') {
        expect(yesNo.probability).toBeGreaterThanOrEqual(0)
        expect(yesNo.probability).toBeLessThanOrEqual(1)
      }
      const pick = judged.answers.area
      expect(pick?.kind).toBe('pick')
      if (pick?.kind === 'pick') {
        expect(Object.keys(PICK.kind === 'pick' ? PICK.options : {})).toContain(pick.picked)
        expect(Object.keys(pick.probabilities).sort()).toEqual(['other', 'payments', 'search'])
        const total = Object.values(pick.probabilities).reduce((sum, one) => sum + one, 0)
        expect(total).toBeCloseTo(1, 5)
        if (judge.capabilities.confidence) expect(typeof pick.confidence).toBe('number')
      }
    })

    it('lands a rate inside the levels it was given', async () => {
      const judge = await make()
      const judged = await judge.ask({ state: 'a typo in a comment', questions: [RATE] })
      const rate = judged.answers.severity
      expect(rate?.kind).toBe('rate')
      if (rate?.kind === 'rate') {
        expect(rate.level).toBeGreaterThanOrEqual(0)
        expect(rate.level).toBeLessThanOrEqual(rate.levels.length - 1)
        expect(rate.levels).toEqual(RATE.kind === 'rate' ? RATE.levels : [])
      }
    })

    it('refuses a question it cannot answer, with what to fix', async () => {
      const judge = await make()
      const refusals: [string, Question[]][] = [
        ['ask at least one', []],
        ['two questions are called', [YES_NO, { ...YES_NO }]],
        ['option', [{ id: 'one_option', kind: 'pick', ask: 'which?', options: { only: null } }]],
        ['level', [{ id: 'one_level', kind: 'rate', ask: 'how bad?', levels: ['fine'] }]],
      ]
      for (const [says, questions] of refusals) {
        await expect(judge.ask({ state: 'x', questions })).rejects.toThrow(new RegExp(says, 'i'))
      }
    })

    it('refuses a state over its budget rather than quietly cutting it', async () => {
      const judge = await make()
      const tokens = judge.capabilities.stateTokens
      const state = 'x'.repeat((tokens + 100) * 4)
      expect(stateTokens(state)).toBeGreaterThan(tokens)
      await expect(judge.ask({ state, questions: [YES_NO] })).rejects.toThrow(/over|cut/i)
    })

    it('says a refusal somebody could retry is one, with what answered', async () => {
      if (!options.refused) return
      const judge = await options.refused()
      const failure = await judge
        .ask({ state: 'anything', questions: [YES_NO] })
        .then(() => null)
        .catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(JudgeError)
      const error = failure as JudgeError
      expect(error.retryable).toBe(true)
      expect(error.message).toBeTruthy()
    })
  })
}
