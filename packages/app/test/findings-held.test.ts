import type { JudgeFinding } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import type { Wiring } from '../src/wire/context.ts'
import { FINDINGS_MS, heldFindings } from '../src/wire/findings.ts'

// What the judges last said, as the window holds it for the races, Evaluations
// and the away view: asked on the beat, kept through a look that failed, and every
// failure said once rather than drawn as a judge with nothing to say.

const one: JudgeFinding = {
  key: 'app/x:test_missing',
  question: 'test_missing',
  project: 'app',
  tasks: ['app/x'],
  at: 1,
  probability: 0.9,
  file: 'src/x.ts',
  stillThere: true,
  account: null,
  verdict: null,
}

type Answer = { findings: JudgeFinding[]; problems: string[]; asked: number }

/** A window whose extensions answer from `answers`, one per look, and whose beat is `beat()`. */
function windowWith(answers: Answer[]) {
  let now = 0
  let ask: (() => void) | null = null
  const noted: string[] = []
  const wire = {
    opts: { extensions: { findings: async () => answers.shift() ?? answers.at(-1) } },
    live: { keepAsking: (_: string, asked: () => void) => (ask = asked) },
    now: () => now,
    draw: () => {},
    note: (err: unknown) => noted.push(err instanceof Error ? err.message : String(err)),
  } as unknown as Wiring
  return {
    wire,
    noted,
    async beat(after = FINDINGS_MS) {
      now += after
      ask?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('what the judges last said', () => {
  it('is null until a judge answers, then what it said', async () => {
    const at = windowWith([{ findings: [one], problems: [], asked: 1 }])
    expect(heldFindings(at.wire)).toBeNull()
    await at.beat()
    expect(heldFindings(at.wire)).toEqual([one])
  })

  it('is null where no judge reads anything here, which is not none found', async () => {
    const at = windowWith([{ findings: [], problems: [], asked: 0 }])
    heldFindings(at.wire)
    await at.beat()
    expect(heldFindings(at.wire)).toBeNull()
  })

  it('keeps what was said through a look that failed, and says the failure once', async () => {
    const at = windowWith([
      { findings: [one], problems: [], asked: 1 },
      { findings: [], problems: ['Jev: no record'], asked: 1 },
      { findings: [], problems: ['Jev: no record'], asked: 1 },
    ])
    heldFindings(at.wire)
    await at.beat()
    await at.beat()
    await at.beat()
    expect(heldFindings(at.wire)).toEqual([one])
    expect(at.noted).toEqual(["the judges' findings could not all be read: Jev: no record"])
  })

  it('asks no oftener than its own clock', async () => {
    let asked = 0
    const at = windowWith([])
    ;(at.wire.opts as { extensions: unknown }).extensions = {
      findings: async () => {
        asked++
        return { findings: [], problems: [], asked: 1 }
      },
    }
    heldFindings(at.wire)
    await at.beat()
    await at.beat(1_000)
    expect(asked).toBe(1)
  })
})
