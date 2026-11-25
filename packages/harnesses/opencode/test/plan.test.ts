import { describe, expect, it } from 'vitest'
import { accountOf, goLimitsIn, integrationsIn, planPays } from '../src/plan.ts'

// `opencode auth list --format json` and `opencode api
// experimental.usage.limits`, as OpenCode 2.4.1 printed them.

const SIGNED_IN = JSON.stringify([
  {
    id: 'openai',
    name: 'OpenAI',
    connections: [{ type: 'credential', id: 'cred_1', label: 'me@example.com', method: 'oauth' }],
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    connections: [{ type: 'credential', id: 'cred_2', label: 'octocat', method: 'oauth' }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    connections: [{ type: 'env', name: 'ANTHROPIC_API_KEY' }],
  },
])

describe('what pays for an OpenCode agent’s turns', () => {
  it('reads what OpenCode says it is connected to, and nothing from anything else', () => {
    const list = integrationsIn(SIGNED_IN)
    expect(list.map((one) => one.id)).toEqual(['openai', 'github-copilot', 'anthropic'])
    expect(list[0]?.connections[0]).toEqual({
      type: 'credential',
      method: 'oauth',
      id: 'cred_1',
      label: 'me@example.com',
      problem: null,
    })
    for (const text of ['', 'nope', '{}', '[1, null, {"name":"x"}]']) {
      expect(integrationsIn(text)).toEqual([])
    }
  })

  it('takes ChatGPT, Copilot and Go for plans, and a key or a router for money', () => {
    const signedIn = integrationsIn(SIGNED_IN)
    expect(planPays('openai', 0, signedIn)).toBe(true)
    expect(planPays('github-copilot', 0, signedIn)).toBe(true)
    expect(planPays('opencode-go', 0, [])).toBe(true)
    expect(planPays('anthropic', 0.4, signedIn)).toBe(false)
    expect(planPays('openrouter', 0, signedIn)).toBe(false)
    expect(planPays(null, 0, signedIn)).toBe(false)
    // OpenAI with a key is billed per token, whatever it cost.
    const keyed = integrationsIn(
      JSON.stringify([
        { id: 'openai', name: 'OpenAI', connections: [{ type: 'env', name: 'OPENAI_API_KEY' }] },
      ]),
    )
    expect(planPays('openai', 0, keyed)).toBe(false)
    // Claude Agent's turns cost nothing on a subscription, and something on a key.
    expect(planPays('claude-agent', 0, [])).toBe(true)
    expect(planPays('claude-agent', 0.1, [])).toBe(false)
  })

  it('says who it is signed in as, the plans among them, and that nothing is not signed in', () => {
    expect(accountOf(integrationsIn(SIGNED_IN))).toEqual({
      signedIn: true,
      who: 'me@example.com',
      plan: 'ChatGPT, GitHub Copilot',
      method: 'OpenAI, GitHub Copilot, Anthropic',
      problem: null,
      until: null,
    })
    const none = accountOf([])
    expect(none.signedIn).toBe(false)
    expect(none.problem).toBeTruthy()
    const troubled = accountOf(
      integrationsIn(
        JSON.stringify([
          {
            id: 'github-copilot',
            name: 'GitHub Copilot',
            connections: [
              {
                type: 'credential',
                id: 'c',
                label: 'octocat',
                method: 'oauth',
                status: { status: 'needs_auth', message: 'sign in again' },
              },
            ],
          },
        ]),
      ),
    )
    expect(troubled.problem).toBe('GitHub Copilot: sign in again')
  })

  it('says OpenCode Go’s windows shortest first, and nothing where it said nothing of Go', () => {
    const said = JSON.stringify({
      location: { directory: '/work' },
      data: {
        workspace: { id: 'wrk', usageURL: 'https://opencode.ai/wrk' },
        go: {
          rolling: { percent: 30, limited: false, resetsAt: 1_000 },
          weekly: { percent: 101, limited: true, resetsAt: 2_000 },
          monthly: { percent: 12, limited: false, resetsAt: 3_000 },
        },
        budgets: [],
      },
    })
    expect(goLimitsIn(said, 7)).toEqual({
      at: 7,
      windows: [
        { minutes: 300, used: 30, resetsAt: 1_000 },
        { minutes: 10_080, used: 100, resetsAt: 2_000 },
        { minutes: 43_200, used: 12, resetsAt: 3_000 },
      ],
    })
    expect(goLimitsIn('{"location":{},"data":null}', 7)).toBeNull()
    expect(goLimitsIn('{"data":{"budgets":[]}}', 7)).toBeNull()
    expect(goLimitsIn('not json', 7)).toBeNull()
  })
})
