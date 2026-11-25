import type { MachineAnswer, OrchestratorStanding } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { causesOf, checkedSaid, type FleetFacts, factsOf, together } from '../src/fleet-due.ts'

// When a reload of every machine is due, and what the check after one says
// (`fleet-due.ts`): pure, so every case is one answer a machine could give.

const UP: OrchestratorStanding = {
  state: 'up',
  said: null,
  shares: true,
  joined: null,
  model: null,
}

const answer = (change: Partial<MachineAnswer> = {}): MachineAnswer => ({
  at: new Date().toISOString(),
  version: '0.4.3',
  newer: null,
  public: null,
  problems: [],
  schedules: [],
  documents: [],
  ...change,
})

const signedIn = (id: string, label: string, state: 'set' | 'missing' = 'set') => ({
  id,
  kind: 'sign-in' as const,
  label,
  state,
  digest: null,
  until: null,
  where: [],
  said: null,
  variables: [],
  service: null,
})

const facts = (change: Partial<FleetFacts> = {}): FleetFacts => ({
  name: 'ipax',
  version: '0.4.3',
  signIns: [],
  orchestrator: UP,
  ...change,
})

describe('what a machine says, read for a reload', () => {
  it('keeps its set sign-ins and its orchestrator, and nothing before it answered', () => {
    const read = factsOf(
      'ipax',
      answer({
        inventory: {
          machine: 'ipax',
          at: new Date().toISOString(),
          shell: null,
          service: true,
          items: [
            signedIn('sign-in:claude-code:vrolta', 'Claude Code · vrolta'),
            signedIn('sign-in:codex', 'Codex', 'missing'),
          ],
        },
        orchestrator: UP,
      }),
    )
    expect(read?.signIns).toEqual([
      { id: 'sign-in:claude-code:vrolta', label: 'Claude Code · vrolta' },
    ])
    expect(read?.orchestrator).toEqual(UP)
    expect(factsOf('ipax', answer())?.orchestrator).toBeNull()
    expect(factsOf('ipax', null)).toBeNull()
  })
})

describe('whether two orchestrators are one conversation', () => {
  it('needs the hub up, sharing, and this window’s last exchange with it', () => {
    expect(together(facts(), 'ipax', 'ipax')).toBe(true)
    expect(together(facts(), 'ipax', null)).toBe(false)
    expect(together(facts({ orchestrator: { ...UP, state: 'failed' } }), 'ipax', 'ipax')).toBe(
      false,
    )
    expect(together(facts({ orchestrator: { ...UP, shares: false } }), 'ipax', 'ipax')).toBe(false)
    expect(together(facts({ orchestrator: null }), 'ipax', 'ipax')).toBe(false)
  })

  it('needs any other machine one with a hub of its own', () => {
    const hetz = facts({ name: 'hetz' })
    expect(together(hetz, 'ipax', 'ipax')).toBe(false)
    expect(together({ ...hetz, orchestrator: { ...UP, joined: 'ipax' } }, 'ipax', null)).toBe(true)
  })
})

describe('a reload due', () => {
  it('for a sign-in newly set there, said with what it fixes and the one action', () => {
    const was = facts({ orchestrator: { ...UP, state: 'failed', said: 'not signed in' } })
    const now = {
      ...was,
      signIns: [{ id: 'sign-in:claude-code:vrolta', label: 'Claude Code · vrolta' }],
    }
    expect(causesOf(was, now)).toEqual([
      {
        machine: 'ipax',
        key: 'ipax|sign-in|sign-in:claude-code:vrolta',
        said: 'Claude Code · vrolta is newly signed in on ipax, so ipax’s orchestrator can now share this conversation — Reload to bring the two together',
      },
    ])
  })

  it('for a model its orchestrator was not given, and for a Tade that can now say how it stands', () => {
    const model = causesOf(
      facts(),
      facts({ orchestrator: { ...UP, model: 'anthropic/claude-opus-5-5' } }),
    )
    expect(model.map((one) => one.key)).toEqual(['ipax|model|anthropic/claude-opus-5-5'])
    expect(model[0]?.said).toContain(
      'ipax’s orchestrator now has a model (anthropic/claude-opus-5-5)',
    )
    const newer = causesOf(facts({ version: '0.3.0', orchestrator: null }), facts())
    expect(newer.map((one) => one.key)).toEqual(['ipax|version|0.4.3'])
    expect(newer[0]?.said).toContain('ipax now runs Tade 0.4.3, which can share the conversation')
  })

  it('for nothing that did not move', () => {
    expect(causesOf(facts(), facts())).toEqual([])
    expect(causesOf(facts({ version: '0.4.2' }), facts())).toEqual([])
  })
})

describe('the check after a reload', () => {
  const here = { name: 'this Mac', standing: { ...UP, joined: 'ipax' } }

  it('says the conversation is one across them all, and that no orchestrator has a problem', () => {
    const said = checkedSaid(
      here,
      [
        { name: 'ipax', facts: facts(), unreached: null },
        {
          name: 'hetz',
          facts: facts({ name: 'hetz', orchestrator: { ...UP, joined: 'ipax' } }),
          unreached: null,
        },
      ],
      'ipax',
      'ipax',
    )
    expect(said).toBe(
      'After the reload: the conversation is one across this Mac and ipax and hetz, and no orchestrator reports a sign-in or model problem.',
    )
  })

  it('names each trouble in that machine’s words, and what did come back', () => {
    const said = checkedSaid(
      here,
      [
        {
          name: 'ipax',
          facts: facts({ orchestrator: { ...UP, state: 'failed', said: 'no model is chosen' } }),
          unreached: null,
        },
        {
          name: 'hetz',
          facts: facts({ name: 'hetz', orchestrator: { ...UP, joined: 'ipax' } }),
          unreached: null,
        },
        { name: 'north', facts: null, unreached: 'its link is not up' },
      ],
      'ipax',
      null,
    )
    expect(said).toBe(
      'After the reload: ipax’s orchestrator did not start: no model is chosen; north did not answer after it: its link is not up. hetz came back as one conversation.',
    )
  })

  it('says where no hub is named, since then nothing is shared', () => {
    const said = checkedSaid(here, [{ name: 'ipax', facts: facts(), unreached: null }], null, null)
    expect(said).toContain('no hub is named')
  })
})
