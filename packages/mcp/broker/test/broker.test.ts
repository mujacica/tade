import { ExtensionHost } from '@tade/extensions-core'
import type { CachedServer, CatalogueEntry, OfferedTool } from '@tade/mcp-core'
import { brokeredConformance } from '@tade/mcp-core/conformance'
import { makeScriptedTransport, type ScriptedServer } from '@tade/mcp-scripted'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { brokered, readable, ServerSessions } from '../src/index.ts'

// A server somebody turned on, as an extension whose tools are that server's
// tools — and everything the broker is not allowed to do with one.

const tool = (name: string, over: Partial<OfferedTool> = {}): OfferedTool => ({
  name,
  description: `Does ${name}.`,
  input: { type: 'object', properties: {} },
  ...over,
})

const catalogue: readonly CatalogueEntry[] = [
  {
    name: 'linear',
    title: 'Linear',
    description: 'Issues in Linear.',
    workflow: ['Ask about an issue by its number.'],
    transport: 'scripted',
    auth: 'env',
    authName: 'LINEAR_API_KEY',
    variables: ['LINEAR_API_KEY'],
  },
  {
    name: 'plain',
    title: 'Plain',
    description: 'A server that wants no credential.',
    workflow: [],
    transport: 'scripted',
  },
]

const offering = (tools: readonly OfferedTool[]): CachedServer => ({
  about: { title: 'A scripted server', version: '1' },
  tools,
  asked: '2026-09-21T08:00:00.000Z',
})

const servers: Record<string, ScriptedServer> = {
  linear: {
    tools: [tool('searchIssues'), tool('createIssue'), tool('broken')],
    answers: {
      searchIssues: { text: 'two issues', failed: false },
      broken: { text: 'the query was not understood', failed: true },
    },
  },
  plain: { tools: [tool('ping')], answers: { ping: { text: 'pong', failed: false } } },
}

const transports = { scripted: () => makeScriptedTransport({ servers }) }

function broke(
  over: Partial<Parameters<typeof brokered>[0]> = {},
  cached: Record<string, readonly OfferedTool[]> = {
    linear: [tool('searchIssues'), tool('createIssue'), tool('broken')],
    plain: [tool('ping')],
  },
) {
  return brokered({
    servers: { linear: { enabled: true }, plain: { enabled: true } },
    home: '/nonexistent',
    catalogue,
    transports,
    cache: (name) => (cached[name] ? offering(cached[name]) : null),
    ...over,
  })
}

// §6.4: a brokered extension fills in `tools`, and nothing else.
brokeredConformance('the broker', () => broke().extensions)

describe('a server that is on', () => {
  it('is an extension whose tools are that server’s tools', () => {
    const [linear] = broke().extensions
    expect(linear?.name).toBe('mcp-linear')
    expect(linear?.tools?.map((one) => one.name)).toEqual([
      'mcp_linear_broken',
      'mcp_linear_createissue',
      'mcp_linear_searchissues',
    ])
  })

  it('hands the server’s own words over as a tool description, and nowhere else', () => {
    const [linear] = broke().extensions
    const found = linear?.tools?.find((one) => one.name === 'mcp_linear_searchissues')
    expect(found?.description).toContain('Does searchIssues.')
    // Whose words they are is said every time they are shown.
    expect(found?.description).toContain('nobody here wrote')
    // And nowhere a model is told what to do: no instructions, no watch, no
    // brief, no status. That is `brokeredConformance` above.
    expect(linear?.agents).toBeUndefined()
    expect(linear?.orchestrator).toBeUndefined()
  })

  it('declares the credential it needs as a secret, never as a setting in the config', () => {
    const [linear, plain] = broke().extensions
    expect(linear?.settings).toEqual([
      expect.objectContaining({ key: 'key', kind: 'secret', env: ['LINEAR_API_KEY'] }),
    ])
    // One that wants none asks for none.
    expect(plain?.settings).toBeUndefined()
  })
})

describe('a server that is not on', () => {
  it('is never handed over at all: no extension, no tools, no process', () => {
    expect(
      brokered({ servers: {}, home: '/nonexistent', catalogue, transports }).extensions,
    ).toEqual([])
    expect(broke({ servers: { linear: { enabled: false }, plain: {} } }).extensions).toEqual([])
  })

  it('is left out by --safe, which has to work with a broken one in the config', () => {
    const made = broke({
      safe: true,
      servers: { linear: { enabled: true }, nonsense: { enabled: true } },
    })
    expect(made.extensions).toEqual([])
    // Still listed, still said to be wrong: safe mode that only works when
    // nothing is wrong is not a recovery path.
    expect(made.servers.find((one) => one.declaration.name === 'nonsense')?.problem).toBeTruthy()
  })
})

describe('what a brokered call does', () => {
  const run = async (tool: string, input: Record<string, unknown> = {}) => {
    const host = await ExtensionHost.load({
      brokered: broke().extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
      env: { LINEAR_API_KEY: 'from-the-shell' },
    })
    return host.call(tool, input, { caller: { kind: 'orchestrator' } })
  }

  it('comes back into the window, and answers with what the server said', async () => {
    expect((await run('mcp_linear_searchissues')).text).toBe('two issues')
  })

  it('throws when the server called its own call a failure, because that is how a tool fails', async () => {
    // Anything else reaches the model as an empty answer that looks like
    // success, which is the one way a tool can lie.
    await expect(run('mcp_linear_broken')).rejects.toThrow('the query was not understood')
  })

  it('is refused at the moment of the call when it is not one the server was turned on for', async () => {
    const host = await ExtensionHost.load({
      brokered: broke({
        servers: { linear: { enabled: true, tools: ['mcp_linear_searchissues'] } },
      }).extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
      env: { LINEAR_API_KEY: 'from-the-shell' },
    })
    // Narrowed when the list was built...
    expect(host.specs('agent').map((spec) => spec.name)).toEqual(['mcp_linear_searchissues'])
    // ...and the call still has to come back here, whatever a harness thinks
    // it has registered.
    await expect(
      host.call('mcp_linear_createissue', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow()
  })
})

describe('a server Tade has not asked what it offers', () => {
  it('offers no tools yet, and says so rather than inventing a list', async () => {
    const host = await ExtensionHost.load({
      brokered: broke({}, {}).extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
      env: { LINEAR_API_KEY: 'from-the-shell' },
    })
    expect(host.specs('agent')).toEqual([])
    expect(host.list().map((one) => [one.state, one.problem])).toEqual([
      ['needs setup', 'nothing has asked linear what it offers yet'],
      ['needs setup', 'nothing has asked plain what it offers yet'],
    ])
  })

  it('has the tools once somebody asked, which is what the cache is for', async () => {
    const home = tmp('mcp-broker-')
    const sessions = new ServerSessions()
    const first = brokered({
      servers: { plain: { enabled: true } },
      home,
      catalogue,
      transports,
      sessions,
    })
    expect(first.extensions[0]?.tools ?? []).toHaveLength(0)
    await first.warm()
    await first.close()
    // A second window, reading what the first wrote down: the first agent
    // after a restart has the tools without anything being dialled.
    const again = brokered({ servers: { plain: { enabled: true } }, home, catalogue, transports })
    expect(again.extensions[0]?.tools?.map((one) => one.name)).toEqual(['mcp_plain_ping'])
  })
})

describe('a server that needs a credential it has not got', () => {
  it('says which variable it looks in and what to paste into, and is never called', async () => {
    const host = await ExtensionHost.load({
      brokered: broke().extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
      env: {},
    })
    const linear = host.list().find((one) => one.name === 'mcp-linear')
    expect(linear?.state).toBe('needs setup')
    expect(linear?.problem).toBe('linear needs a credential: paste one, or set $LINEAR_API_KEY')
    expect(host.specs('agent').map((spec) => spec.name)).toEqual(['mcp_plain_ping'])
  })
})

describe('somebody else’s text, as Tade may draw it', () => {
  it('has its control characters taken out and is capped where it is long', () => {
    expect(readable('a bc')).toBe('a b c')
    // Newlines and tabs stay: a description is markdown somebody wrote.
    expect(readable('one\ntwo')).toBe('one\ntwo')
    expect(readable('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})
