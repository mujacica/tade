import { describe, expect, it } from 'vitest'
import { deltaBetween } from '../src/delta.ts'
import { BUDGET } from '../src/page.ts'
import { snapshotOf } from '../src/snapshot.ts'
import {
  blocked,
  EVERY,
  finding,
  input,
  intake,
  NOW,
  note,
  plan,
  project,
  queued,
  reach,
  run,
  task,
  workflow,
} from './fixtures.ts'

// **Every text a device reads goes out whole**: the person asked to read every
// answer in full on a phone, so a note, a title, a reason, an account, a
// request's body, a step's prompt and a command each cross as they were
// written, however long — and a beat that changed something else does not send
// them again.

/** Over ten thousand characters, with lines, wide characters and an astral one in them. */
const long = (tag: string): string =>
  `${tag} begins\n${Array.from({ length: 700 }, (_, n) => `${tag} line ${n} — wörds 🔧`).join('\n')}\n${tag} ends`

const TEXTS = {
  title: long('TITLE'),
  intent: long('INTENT'),
  account: long('ACCOUNT'),
  why: long('WAITS-WHY'),
  said: long('FOUND-SAID'),
  note: long('NOTE'),
  summary: long('SUMMARY'),
  plan: long('PLAN'),
  body: long('BODY'),
  prompt: long('PROMPT'),
  about: long('ABOUT'),
  stepWhy: long('STEP-WHY'),
  command: long('COMMAND'),
  project: long('PROJECT'),
}

function whole() {
  const one = workflow()
  const ran = run()
  const waiting = blocked()
  return input({
    reach: { ...reach(EVERY), answers: true },
    projects: [project({ title: TEXTS.project })],
    tasks: [
      task({ title: TEXTS.title, intent: TEXTS.intent, account: TEXTS.account }),
      { ...waiting, approval: { ...waiting.approval!, command: TEXTS.command } },
    ],
    queue: [queued({ waitsOn: [{ task: 'sentry/away-projection', why: TEXTS.why }] })],
    findings: [
      finding({ account: { did: 'not real', said: TEXTS.said, at: '2026-10-08T14:05:00.000Z' } }),
    ],
    notes: [note({ text: TEXTS.note, summary: TEXTS.summary })],
    plans: [plan({ account: TEXTS.plan })],
    intake: [intake({ material: TEXTS.body })],
    runs: [
      run({
        steps: ran.steps.map((step) =>
          step.waits.length === 0
            ? step
            : { ...step, waits: step.waits.map((wait) => ({ ...wait, why: TEXTS.stepWhy })) },
        ),
      }),
    ],
    workflows: [
      workflow({
        about: TEXTS.about,
        steps: one.steps.map((step) => ({ ...step, prompt: TEXTS.prompt })),
      }),
    ],
  })
}

describe('a long text, on every surface', () => {
  it('is long enough to have been cut before', () => {
    for (const text of Object.values(TEXTS)) expect([...text].length).toBeGreaterThan(10_000)
    expect(BUDGET.text).toBe(Number.POSITIVE_INFINITY)
    expect(BUDGET.material).toBe(Number.POSITIVE_INFINITY)
  })

  it('crosses whole, and nothing on the wire says there was more', () => {
    const wire = JSON.stringify(snapshotOf(whole(), NOW))
    for (const [where, text] of Object.entries(TEXTS)) {
      expect(wire.includes(JSON.stringify(text).slice(1, -1)), where).toBe(true)
    }
    expect(wire).not.toContain('"more":true')
    expect(wire).not.toMatch(/"notShown":[1-9]/)
  })

  it('is not sent again by a beat that moved something else', () => {
    const was = snapshotOf(whole(), NOW)
    const moved = whole()
    moved.lifetime = { ...moved.lifetime, rev: moved.lifetime.rev + 1 }
    moved.tasks = moved.tasks.map((one, at) => (at === 0 ? { ...one, dirty: 8 } : one))
    const delta = deltaBetween(was, snapshotOf(moved, NOW + 2_000))
    expect(delta).not.toBeNull()
    const sent = JSON.stringify(delta)
    expect(sent).toContain('"dirty":8')
    for (const [where, text] of Object.entries(TEXTS)) {
      expect(sent.includes(text.slice(0, 40)), where).toBe(false)
    }
  })
})
