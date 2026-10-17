import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter } from '../src/adapter.ts'

// What pi makes of the model a route hands it, asked of pi itself.
//
// A route keeps a `provider` beside its model, and pi reads the two as one
// (`--provider p --model m`). Where `m` is another provider's spelling pi does
// not refuse: it makes up a model of `p`'s called `m`, and the agent starts on
// nothing anybody offers. This holds that, and that the model alone — what a
// Settings press across providers leaves, and what new agents fall back to
// (`startingModel`) — is a model pi really has. If a pi release starts to
// refuse the pair instead, this is where it shows.

/** Two providers' worth of catalog, as pi's runtime hands it to the resolver. */
const CATALOG = [
  { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5' },
  { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { provider: 'openrouter', id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5' },
  { provider: 'openrouter', id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
]

/** What pi starts on for a model as Tade hands it: the line it is launched with, resolved by pi. */
async function startsOn(model: { id: string; provider?: string }) {
  const { resolveCliModel } = await import('@earendil-works/pi-coding-agent')
  const args = new PiAdapter({ runDir: tmp('tade-pi-') }).launchSpec({
    run: 'r1',
    task: 'app/refunds',
    cwd: '/wt/refunds',
    prompt: '',
    model,
  }).args
  const after = (flag: string) => {
    const at = args.indexOf(flag)
    return at < 0 ? undefined : args[at + 1]
  }
  const resolved = resolveCliModel({
    cliProvider: after('--provider'),
    cliModel: after('--model'),
    modelRuntime: {
      getModels: () => CATALOG,
      hasConfiguredAuth: () => true,
    } as never,
  })
  const found = resolved.model
  return {
    model: found ? `${found.provider}/${found.id}` : null,
    offered: CATALOG.some((one) => one.provider === found?.provider && one.id === found?.id),
    warning: resolved.warning ?? null,
  }
}

describe('the model pi starts a new agent on', () => {
  it('is made up when a route keeps a provider beside another provider’s model', async () => {
    const pair = await startsOn({
      provider: 'anthropic',
      id: 'openrouter/anthropic/claude-opus-4.5',
    })
    expect(pair.model).toBe('anthropic/openrouter/anthropic/claude-opus-4.5')
    expect(pair.offered).toBe(false)
    expect(pair.warning).toContain('Using custom model id')
  })

  it('is a model pi has, for the model alone and for a pair that is one of the provider’s', async () => {
    expect(await startsOn({ id: 'openrouter/anthropic/claude-opus-4.5' })).toEqual({
      model: 'openrouter/anthropic/claude-opus-4.5',
      offered: true,
      warning: null,
    })
    // What the old route-keeping wrote: OpenRouter's own id, beside it.
    expect(await startsOn({ provider: 'openrouter', id: 'anthropic/claude-opus-4.5' })).toEqual({
      model: 'openrouter/anthropic/claude-opus-4.5',
      offered: true,
      warning: null,
    })
    // The provider said twice, which pi takes its own prefix off.
    expect(await startsOn({ provider: 'anthropic', id: 'anthropic/claude-opus-5' })).toEqual({
      model: 'anthropic/claude-opus-5',
      offered: true,
      warning: null,
    })
  })
})
