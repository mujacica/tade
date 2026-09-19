import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.ts'
import { orchestratorRoute, resolveRoute, UnknownRouteError } from '../src/routes.ts'

const config = (yaml: Record<string, unknown>) => ConfigSchema.parse(yaml)

const routed = config({
  workers: {
    default: 'cheap',
    routes: {
      cheap: { provider: 'openrouter', model: 'deepseek/deepseek-v3' },
      subscription: { provider: 'anthropic', model: 'claude-opus-5' },
      local: { provider: 'ollama', model: 'qwen2.5-coder', sandbox: 'seatbelt' },
    },
  },
  projects: {
    checkout: { root: '~/src/checkout', worker: 'subscription' },
    search: { root: '~/src/search' },
  },
})

describe('resolveRoute', () => {
  it('falls back to the configured default', () => {
    expect(resolveRoute(routed)).toMatchObject({ name: 'cheap', provider: 'openrouter' })
  })

  it('prefers the project route over the default', () => {
    expect(resolveRoute(routed, { project: 'checkout' })).toMatchObject({
      name: 'subscription',
      model: 'claude-opus-5',
    })
  })

  it('uses the default for a project that names no route', () => {
    expect(resolveRoute(routed, { project: 'search' }).name).toBe('cheap')
  })

  it('an explicit override beats everything', () => {
    expect(resolveRoute(routed, { project: 'checkout', route: 'local' })).toMatchObject({
      name: 'local',
      sandbox: 'seatbelt',
    })
  })

  it('carries the sandbox and harness through', () => {
    expect(resolveRoute(routed, { route: 'local' })).toMatchObject({
      harness: 'pi',
      sandbox: 'seatbelt',
    })
    expect(resolveRoute(routed, { route: 'cheap' }).sandbox).toBe('none')
  })

  it('uses the only route there is, whatever it is named', () => {
    const single = config({ workers: { routes: { solo: { model: 'x' } } } })
    expect(resolveRoute(single).name).toBe('solo')
  })

  it('an empty config resolves to the built-in default route', () => {
    expect(resolveRoute(config({}))).toMatchObject({ name: 'default', harness: 'pi' })
  })

  it('throws a named error for an unknown override', () => {
    expect(() => resolveRoute(routed, { route: 'nope' })).toThrow(UnknownRouteError)
    expect(() => resolveRoute(routed, { route: 'nope' })).toThrow(/cheap, subscription, local/)
  })
})

describe('orchestratorRoute', () => {
  it('defaults to pi with no model pinned', () => {
    expect(orchestratorRoute(config({}))).toMatchObject({ name: 'orchestrator', harness: 'pi' })
  })

  it('carries provider and model when set', () => {
    const c = config({ orchestrator: { provider: 'anthropic', model: 'claude-opus-5' } })
    expect(orchestratorRoute(c)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' })
  })

  it('carries how hard it was told to think, like an agent route does', () => {
    const c = config({ orchestrator: { thinking: 'xhigh' } })
    expect(orchestratorRoute(c)).toMatchObject({ thinking: 'xhigh' })
    // Unset is the harness's own default, not a level of our choosing.
    expect(orchestratorRoute(config({})).thinking).toBeUndefined()
  })
})

describe('route validation', () => {
  it('rejects a project pointing at a route that does not exist', () => {
    const result = ConfigSchema.safeParse({
      workers: { default: 'cheap', routes: { cheap: {} } },
      projects: { checkout: { root: '~/x', worker: 'typo' } },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path.join('.')).toBe('projects.checkout.worker')
    expect(result.error?.issues[0]?.message).toMatch(/unknown route "typo"/)
  })

  it('rejects a default naming a route that does not exist', () => {
    const result = ConfigSchema.safeParse({
      workers: { default: 'nope', routes: { a: {}, b: {} } },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path.join('.')).toBe('workers.default')
  })

  it('accepts a single route that is not called default', () => {
    expect(ConfigSchema.safeParse({ workers: { routes: { solo: {} } } }).success).toBe(true)
  })
})
