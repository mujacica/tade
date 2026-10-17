import { type Config, ConfigSchema } from '@tade/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type LinearScript, linearScript } from '../../../../test/fixtures/linear/linear.ts'
import {
  LINEAR_CONNECTED_BY,
  LINEAR_REFRESHED_BY,
  LinearTokens,
  lending,
  MARGIN_MS,
} from '../../src/wire/linear-tokens.ts'

// The Linear app's tokens as the window holds them (REMOTE-TADE §6.3): a day's
// access token handed to whatever asks, refreshed near its end, one refresh at
// a time, and the refresh token that replaces itself written back through the
// one write path — against a Linear that answers from a file and spends a
// refresh token the way Linear does.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the Linear token tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

const CLIENT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'
const DAY_S = 86399

function holder(
  over: { intake?: Record<string, unknown>; linear?: LinearScript; refuseWrites?: boolean } = {},
) {
  const linear =
    over.linear ?? linearScript({ base: 0, oauth: { clientId: CLIENT, refresh: 'lin_refresh_0' } })
  let config: Config = ConfigSchema.parse({
    extensions: {
      intake: over.intake ?? { linear_client_id: CLIENT, linear_refresh_token: 'lin_refresh_0' },
    },
  })
  let now = Date.parse('2026-10-17T12:00:00Z')
  const wrote: { key: string; value: unknown; was: string; by: string | undefined }[] = []
  const told: string[] = []
  let refuse = over.refuseWrites === true
  const tokens = new LinearTokens({
    config: () => config,
    settings: {
      writeKey: async (key, value, was, how) => {
        if (refuse) throw new Error('the disk is full')
        wrote.push({ key, value, was, by: how?.by })
        const leaf = key.split('.').at(-1) ?? ''
        const intake = { ...(config.extensions.intake ?? {}) }
        if (value === undefined) delete intake[leaf]
        else intake[leaf] = value
        config = { ...config, extensions: { ...config.extensions, intake } }
      },
    },
    now: () => now,
    fetch: linear.fetch,
    told: (said) => told.push(said),
  })
  return {
    tokens,
    linear,
    wrote,
    told,
    config: () => config,
    pass: (ms: number) => {
      now += ms
    },
    writes: (on: boolean) => {
      refuse = !on
    },
    replace: (intake: Record<string, unknown>) => {
      config = ConfigSchema.parse({ extensions: { intake } })
    },
  }
}

const grants = (linear: LinearScript) =>
  linear.oauth?.calls.filter((one) => one.status === 200).length ?? 0

describe('a token for whatever asks', () => {
  it('is nothing where no app is connected, and asks Linear nothing', async () => {
    const { tokens, linear } = holder({ intake: { linear_client_id: CLIENT } })
    expect(await tokens.token()).toBeNull()
    expect(linear.oauth?.calls).toEqual([])
  })

  it('refreshes once, keeps the refresh token it was handed, and hands the same token out for a day', async () => {
    const { tokens, linear, wrote, config, pass } = holder()
    const first = await tokens.token()
    expect(first).toBe('lin_oauth_access_1')
    expect(wrote).toEqual([
      {
        key: 'extensions.intake.linear_refresh_token',
        value: 'lin_refresh_1',
        was: 'set',
        by: LINEAR_REFRESHED_BY,
      },
    ])
    expect(config().extensions.intake?.linear_refresh_token).toBe('lin_refresh_1')
    // Never the access token: it lives in this window's memory.
    expect(JSON.stringify(config())).not.toContain('lin_oauth_access')
    pass(DAY_S * 1000 - MARGIN_MS - 1000)
    expect(await tokens.token()).toBe(first)
    expect(grants(linear)).toBe(1)
  })

  it('refreshes with the token it kept once the one it holds is near its end', async () => {
    const { tokens, linear, wrote, pass } = holder()
    await tokens.token()
    pass(DAY_S * 1000 - MARGIN_MS + 1000)
    expect(await tokens.token()).toBe('lin_oauth_access_2')
    expect(linear.oauth?.calls.map((one) => one.form.refresh_token)).toEqual([
      'lin_refresh_0',
      'lin_refresh_1',
    ])
    expect(wrote.map((one) => one.value)).toEqual(['lin_refresh_1', 'lin_refresh_2'])
  })

  it('refreshes once however many ask at once, since two would spend one token twice', async () => {
    const { tokens, linear } = holder()
    const all = await Promise.all([tokens.token(), tokens.token(), tokens.token()])
    expect(new Set(all)).toEqual(new Set(['lin_oauth_access_1']))
    expect(linear.oauth?.calls).toHaveLength(1)
  })

  it('never sends a client secret', async () => {
    const { tokens, linear } = holder()
    await tokens.token()
    expect(linear.oauth?.calls[0]?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'lin_refresh_0',
      client_id: CLIENT,
    })
  })
})

describe('when Linear will not take it', () => {
  it('says to connect it again, as auth, and holds nothing', async () => {
    const linear = linearScript({ base: 0, oauth: { clientId: CLIENT, refresh: 'lin_refresh_0' } })
    linear.oauth?.revoke()
    const { tokens, wrote } = holder({ linear })
    await expect(tokens.token()).rejects.toMatchObject({
      trouble: 'auth',
      message: expect.stringContaining('connect Linear again at /connect'),
    })
    expect(wrote).toEqual([])
  })

  it('says the client id is gone rather than refreshing without one', async () => {
    const { tokens, linear } = holder({ intake: { linear_refresh_token: 'lin_refresh_0' } })
    await expect(tokens.token()).rejects.toThrow(/client id/)
    expect(linear.oauth?.calls).toEqual([])
  })

  it('passes on that nothing answered, which is not a refused token', async () => {
    const linear = linearScript({
      base: 0,
      offline: true,
      oauth: { clientId: CLIENT, refresh: 'lin_refresh_0' },
    })
    const { tokens } = holder({ linear })
    await expect(tokens.token()).rejects.toThrow(/did not answer/)
  })
})

describe('what replaces it', () => {
  it('holds what connecting handed over, and keeps its refresh token as connecting Linear', async () => {
    const { tokens, linear, wrote } = holder({ intake: { linear_client_id: CLIENT } })
    expect(
      await tokens.took({ access: 'lin_oauth_new', refresh: 'lin_refresh_new', expiresIn: DAY_S }),
    ).toBeNull()
    expect(wrote).toEqual([
      {
        key: 'extensions.intake.linear_refresh_token',
        value: 'lin_refresh_new',
        was: 'not set',
        by: LINEAR_CONNECTED_BY,
      },
    ])
    expect(await tokens.token()).toBe('lin_oauth_new')
    expect(linear.oauth?.calls).toEqual([])
  })

  it('lets go of what it held once the config names another refresh token, or none', async () => {
    const { tokens, replace } = holder()
    await tokens.token()
    replace({ linear_client_id: CLIENT })
    expect(await tokens.token()).toBeNull()
  })

  it('drops what a refresh in flight hands back once connected again meanwhile', async () => {
    const { tokens, wrote } = holder()
    const refreshing = tokens.token()
    await tokens.took({ access: 'lin_oauth_new', refresh: 'lin_refresh_new', expiresIn: DAY_S })
    expect(await refreshing).toBe('lin_oauth_new')
    // The old connection's next token was never written over the new one.
    expect(wrote.map((one) => one.value)).toEqual(['lin_refresh_new'])
    expect(await tokens.token()).toBe('lin_oauth_new')
  })

  it('carries on with a token it could not write down, says so once, and writes it at the next ask', async () => {
    const { tokens, told, wrote, writes, config } = holder({ refuseWrites: true })
    expect(await tokens.token()).toBe('lin_oauth_access_1')
    expect(await tokens.token()).toBe('lin_oauth_access_1')
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('the disk is full')
    expect(told[0]).not.toContain('lin_refresh')
    writes(true)
    expect(await tokens.token()).toBe('lin_oauth_access_1')
    expect(wrote.map((one) => one.value)).toEqual(['lin_refresh_1'])
    expect(config().extensions.intake?.linear_refresh_token).toBe('lin_refresh_1')
  })
})

describe('what the extensions are lent', () => {
  it('is Linear’s token for Linear, and nothing for a source read some other way', async () => {
    const { tokens } = holder()
    const lend = lending(tokens)
    expect(await lend('linear')).toBe('lin_oauth_access_1')
    expect(await lend('github')).toBeNull()
    expect(await lend('slack')).toBeNull()
  })
})
