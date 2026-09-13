import { describe, expect, it } from 'vitest'
import { composePrompt } from '../src/compose.ts'
import { ConfigSchema } from '../src/config.ts'
import type { Note } from '../src/memory.ts'

// What Wilco believes about itself. Deterministic on purpose: a change here is
// a change in behaviour, and it should be visible in a diff rather than felt
// three days later.

const config = (projects: Record<string, { root: string; brief?: string }> = {}) =>
  ConfigSchema.parse({ projects })

const note = (text: string, scope: string | null, at: string): Note => ({
  text,
  scope,
  by: 'voice',
  at,
})

describe('composePrompt', () => {
  it('says what it is and what it does not do', () => {
    const prompt = composePrompt({ config: config() })
    // The single most important thing: it delegates rather than edits.
    expect(prompt).toContain('You delegate')
    expect(prompt).toContain('wilco_status')
  })

  it('lists the projects with their briefs', () => {
    const prompt = composePrompt({
      config: config({
        checkout: { root: '/src/checkout', brief: 'Payments. Stripe, Postgres, Node.' },
        search: { root: '/src/search' },
      }),
    })
    expect(prompt).toContain('- checkout: /src/checkout — Payments. Stripe, Postgres, Node.')
    expect(prompt).toContain('- search: /src/search')
  })

  it('is in a stable order however the config was written', () => {
    const one = composePrompt({ config: config({ b: { root: '/b' }, a: { root: '/a' } }) })
    const two = composePrompt({ config: config({ a: { root: '/a' }, b: { root: '/b' } }) })
    expect(one).toBe(two)
  })

  it('says plainly when there is nothing configured', () => {
    // Rather than letting it invent a project to talk about.
    expect(composePrompt({ config: config() })).toContain('No projects are configured')
  })

  it('passes on what you told it, in your words', () => {
    const prompt = composePrompt({
      config: config({ checkout: { root: '/src/checkout' } }),
      notes: [
        note('we pin major versions', null, '2026-09-10T10:00:00.000Z'),
        note('the staging key rotates on the 1st', 'checkout', '2026-09-11T10:00:00.000Z'),
      ],
    })
    expect(prompt).toContain('- we pin major versions')
    expect(prompt).toContain('- (checkout) the staging key rotates on the 1st')
  })

  it('keeps the newest notes and caps how many', () => {
    // A prompt that grows without limit is one that stops being read.
    const many = Array.from({ length: 40 }, (_, i) =>
      note(`thing ${i}`, null, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`),
    )
    const prompt = composePrompt({ config: config(), notes: many, maxNotes: 3 })
    expect(prompt).toContain('thing 39')
    expect(prompt).not.toContain('thing 0\n')
    expect(prompt.split('- thing').length - 1).toBe(3)
  })

  it('leaves the section out entirely when it has been told nothing', () => {
    expect(composePrompt({ config: config() })).not.toContain('Things you have been told')
  })

  it('tells it that a proposed tool is not a tool it has', () => {
    expect(composePrompt({ config: config() })).toContain('Proposals do nothing')
  })
})

describe('what it is told about this machine', () => {
  it('says whether agents survive the window closing', () => {
    const tmux = composePrompt({ config: ConfigSchema.parse({ workspace: { driver: 'tmux' } }) })
    expect(tmux).toContain('keep working after Wilco is closed')
    // The other way round is the one worth warning about: somebody is about to
    // close a laptop expecting work to carry on.
    const pty = composePrompt({ config: ConfigSchema.parse({ workspace: { driver: 'pty' } }) })
    expect(pty).toContain('stop when it closes')
  })

  it('says whether anything will stop to ask', () => {
    const on = composePrompt({ config: ConfigSchema.parse({ approvals: { mode: 'policy' } }) })
    expect(on).toContain('held until a human answers')
    const off = composePrompt({ config: ConfigSchema.parse({}) })
    expect(off).toContain('nothing is ever held up')
  })

  it('says what a project may spend, where there is a limit', () => {
    const prompt = composePrompt({
      config: ConfigSchema.parse({
        projects: { checkout: { root: '/src/checkout', budget: { usd_per_day: 20 } } },
      }),
    })
    expect(prompt).toContain('checkout may spend $20.00 a day')
  })

  it('says nothing about budgets where none are set', () => {
    // A prompt that lists every absent setting is one that stops being read.
    const prompt = composePrompt({
      config: ConfigSchema.parse({ projects: { checkout: { root: '/src/checkout' } } }),
    })
    expect(prompt).not.toContain('may spend')
  })

  it('tells it what it cannot do, and what does it instead', () => {
    // Otherwise "turn approvals on" gets either a flat refusal or a pretence.
    expect(composePrompt({ config: ConfigSchema.parse({}) })).toContain('wilco config')
  })
})
