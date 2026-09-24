import { ExtensionHost } from '@tade/extensions-core'
import type {
  CachedServer,
  CatalogueEntry,
  OfferedTool,
  ServerDeclaration,
  TransportCapabilities,
  TransportContext,
} from '@tade/mcp-core'
import { CATALOGUE } from '@tade/mcp-core'
import { brokeredConformance } from '@tade/mcp-core/conformance'
import { makeScriptedTransport, type ScriptedServer } from '@tade/mcp-scripted'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { brokered, fetchesCode, readable, ServerSessions, shownServers } from '../src/index.ts'

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

describe('the gate at the moment of the call', () => {
  /** A host holding whatever the broker made of these settings and this environment. */
  const gate = async (
    servers: Record<string, { enabled?: boolean; tools?: string[] }>,
    env: Record<string, string> = { LINEAR_API_KEY: 'from-the-shell' },
  ) =>
    ExtensionHost.load({
      brokered: broke({ servers }).extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
      env,
    })

  it('refuses the call when the credential has gone, and never opens the server', async () => {
    // A harness was handed this tool at launch, when there was a key. The
    // key going is not something a harness can be told about, so the only
    // place it can be answered is here, at the call.
    const opens: string[] = []
    const watched = {
      scripted: () => {
        const transport = makeScriptedTransport({ servers })
        return {
          ...transport,
          open: (server: ServerDeclaration, ctx: TransportContext) => {
            opens.push(server.name)
            return transport.open(server, ctx)
          },
        }
      },
    }
    const host = await ExtensionHost.load({
      brokered: broke({ servers: { linear: { enabled: true } }, transports: watched }).extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
      env: {},
    })
    await expect(
      host.call('mcp_linear_searchissues', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/needs a credential/)
    expect(opens).toEqual([])
  })

  it('refuses the call for a server that was turned off, whatever a harness still offers', async () => {
    // The tool list is written at agent launch, so an agent started while a
    // server was on keeps the name in its list after somebody turns it off.
    const on = await gate({ linear: { enabled: true } })
    expect(on.specs('agent').map((spec) => spec.name)).toContain('mcp_linear_searchissues')
    const off = await gate({ linear: { enabled: false } })
    expect(off.specs('agent')).toEqual([])
    await expect(
      off.call('mcp_linear_searchissues', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/no extension has a tool called mcp_linear_searchissues/)
  })

  it('caps and cleans what a server answers with, before anybody draws or reads it', async () => {
    // Somebody else's text, on a terminal Tade draws and in a model's
    // context: control characters out, and never longer than it says it is.
    const host = await ExtensionHost.load({
      brokered: broke({
        servers: { plain: { enabled: true } },
        transports: {
          scripted: () =>
            makeScriptedTransport({
              servers: {
                plain: {
                  tools: [tool('ping')],
                  answers: {
                    ping: { text: `over\u0000there\u001b[2J${'x'.repeat(40_000)}`, failed: false },
                  },
                },
              },
            }),
        },
      }).extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
    })
    const { text } = await host.call('mcp_plain_ping', {}, { caller: { kind: 'orchestrator' } })
    // Read as code points rather than as a pattern: a control character is
    // what is being looked for, and lint refuses one written into a regex.
    const codes = [...text].map((one) => one.codePointAt(0) ?? 0)
    expect(codes.some((code) => code < 9 || (code > 10 && code < 32) || code === 127)).toBe(false)
    expect(text.startsWith('over there ')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(20_001)
  })
})

describe('a server that goes away while it is being used', () => {
  /** A host over one scripted server, with how many times it was opened. */
  const using = async (server: ScriptedServer) => {
    const opens: string[] = []
    const transports = {
      scripted: () => {
        const transport = makeScriptedTransport({ servers: { plain: server } })
        return {
          ...transport,
          open: (declaration: ServerDeclaration, ctx: TransportContext) => {
            opens.push(declaration.name)
            return transport.open(declaration, ctx)
          },
        }
      },
    }
    const host = await ExtensionHost.load({
      brokered: broke({ servers: { plain: { enabled: true } }, transports }).extensions,
      config: { extensions: {}, projects: {} },
      home: tmp('mcp-broker-'),
    })
    return { host, opens }
  }

  const ping = (host: ExtensionHost) =>
    host.call('mcp_plain_ping', {}, { caller: { kind: 'orchestrator' } })

  it('is opened again once, because a dead server is not a dead window', async () => {
    const { host, opens } = await using({
      tools: [tool('ping')],
      answers: { ping: { text: 'pong', failed: false } },
      // It survives one call and then goes, the way a program that crashed
      // between two agents' calls does.
      diesAfter: 1,
    })
    expect((await ping(host)).text).toBe('pong')
    expect((await ping(host)).text).toBe('pong')
    // One session held and one reopened: never one per call, which under a
    // transport that starts programs would be a process per call.
    expect(opens).toEqual(['plain', 'plain'])
  })

  it('says so when it dies twice, rather than opening it for ever', async () => {
    const { host, opens } = await using({
      tools: [tool('ping')],
      answers: { ping: { text: 'pong', failed: false } },
      diesAfter: 0,
    })
    await expect(ping(host)).rejects.toThrow(/stopped/)
    expect(opens).toEqual(['plain', 'plain'])
  })
})

describe('somebody else’s text, as Tade may draw it', () => {
  it('has its control characters taken out and is capped where it is long', () => {
    expect(readable('a\x00b\x1bc')).toBe('a b c')
    // Newlines and tabs stay: a description is markdown somebody wrote.
    expect(readable('one\ntwo')).toBe('one\ntwo')
    expect(readable('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('asking each server what it offers, once', () => {
  /** The scripted transport, with what each open was given kept for reading. */
  function watching(capabilities: Partial<TransportCapabilities> = {}) {
    const opens: { name: string; credential: string | null; cwd: string | undefined }[] = []
    const made = {
      scripted: () => {
        const transport = makeScriptedTransport({ servers, capabilities })
        return {
          ...transport,
          open: (server: ServerDeclaration, ctx: TransportContext) => {
            opens.push({ name: server.name, credential: ctx.credential, cwd: ctx.cwd })
            return transport.open(server, ctx)
          },
        }
      },
    }
    return { opens, transports: made }
  }

  it('hands the server the credential, found the way an extension’s is', async () => {
    const { opens, transports: watched } = watching()
    const made = brokered({
      servers: { linear: { enabled: true } },
      home: tmp('mcp-broker-'),
      catalogue,
      transports: watched,
      env: { LINEAR_API_KEY: 'from-the-shell' },
    })
    await made.warm()
    await made.close()
    // The environment wins, and the warm-up may not open a server without
    // the credential it will be called with: it is the same session.
    expect(opens).toEqual([{ name: 'linear', credential: 'from-the-shell', cwd: undefined }])
  })

  it('says why one could not be asked, rather than leaving a window that looks fine', async () => {
    const said: string[] = []
    const made = brokered({
      servers: { refuses: { enabled: true, transport: 'scripted' } },
      home: tmp('mcp-broker-'),
      catalogue,
      transports: {
        scripted: () =>
          makeScriptedTransport({ servers: { refuses: { refuses: 'it fell over at once' } } }),
      },
      onWarning: (message) => said.push(message),
    })
    // Nothing throws: a server that will not answer is a row on a page.
    await expect(made.warm()).resolves.toBeUndefined()
    expect(said[0]).toContain('refuses could not be asked what it offers')
  })

  it('opens a project-scoped one in the project it runs for, and one per project', async () => {
    // One that starts a program, because only a server Tade starts can be
    // one per project — which the transport says of itself, not its name.
    const { opens, transports: watched } = watching({ spawns: true })
    const made = brokered({
      // A command, because a transport that starts one is a transport that
      // has to be told which — the same reading that lets it be per project.
      servers: { plain: { enabled: true, scope: 'project', command: 'a-program' } },
      home: tmp('mcp-broker-'),
      catalogue,
      transports: watched,
      cache: () => offering([tool('ping')]),
    })
    const host = await ExtensionHost.load({
      brokered: made.extensions,
      config: {
        extensions: {},
        projects: { shop: { root: '/src/shop' }, site: { root: '/src/site' } },
      },
      home: tmp('mcp-broker-'),
    })
    const from = (project: string) =>
      host.call(
        'mcp_plain_ping',
        {},
        { caller: { kind: 'agent', task: 't', project, cwd: `/src/${project}` } },
      )
    await from('shop')
    await from('shop')
    await from('site')
    // One per project, and never one per agent: two calls from the same
    // project are the same server.
    expect(opens).toEqual([
      { name: 'plain', credential: null, cwd: '/src/shop' },
      { name: 'plain', credential: null, cwd: '/src/site' },
    ])
  })
})

describe('a server that will not start', () => {
  it('is listed broken with what it said, rather than as one nobody has asked yet', async () => {
    const home = tmp('mcp-broker-')
    const made = brokered({
      servers: { plain: { enabled: true } },
      home,
      catalogue,
      transports: {
        scripted: () =>
          makeScriptedTransport({ servers: { plain: { refuses: 'no such database' } } }),
      },
    })
    await made.warm()
    const host = await ExtensionHost.load({
      brokered: made.extensions,
      config: { extensions: {}, projects: {} },
      home,
    })
    const plain = host.list().find((one) => one.name === 'mcp-plain')
    expect(plain?.state).toBe('needs setup')
    expect(plain?.problem).toContain('would not start')
    // The server's own words, which are the part somebody can act on.
    expect(plain?.problem).toContain('no such database')
    // And nothing else is touched by it.
    expect(host.list()).toHaveLength(1)
  })

  it('writes down a changed tool list, for the window that comes after this one', async () => {
    const home = tmp('mcp-broker-')
    const made = brokered({
      servers: { plain: { enabled: true } },
      home,
      catalogue,
      transports: {
        scripted: () =>
          makeScriptedTransport({
            servers: { plain: { tools: [tool('ping')], changesAfterMs: 1 } },
          }),
      },
    })
    await made.warm()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await made.close()
    const again = brokered({ servers: { plain: { enabled: true } }, home, catalogue, transports })
    expect(again.extensions[0]?.tools?.map((one) => one.name)).toEqual(['mcp_plain_ping'])
  })
})

describe('a server as a page says it', () => {
  it('says what it offered only for one somebody turned on', () => {
    const [off, on] = [
      shownServers(broke({ servers: { plain: {} } }).servers, {
        home: '/nonexistent',
        servers: { plain: {} },
        cache: () => offering([tool('ping')]),
      }).find((one) => one.name === 'plain'),
      shownServers(broke().servers, {
        home: '/nonexistent',
        servers: { plain: { enabled: true } },
        cache: () => offering([tool('ping')]),
      }).find((one) => one.name === 'plain'),
    ]
    // Off was never connected: no tools, and no "last asked".
    expect(off?.on).toBe(false)
    expect(off?.tools).toEqual([])
    expect(off?.asked).toBeNull()
    expect(off?.decided).toBe(true)
    expect(on?.tools.map((one) => [one.name, one.from])).toEqual([['mcp_plain_ping', 'ping']])
    expect(on?.asked).toBe('2026-09-21T08:00:00.000Z')
  })

  it('says how Tade talks to it, and never says a credential at all', () => {
    const shown = shownServers(
      broke({
        servers: {
          linear: { enabled: true },
          mine: { enabled: true, transport: 'scripted', command: 'a-program', args: ['--stdio'] },
        },
      }).servers,
      { home: '/nonexistent', cache: () => null },
    )
    const said = JSON.stringify(shown)
    expect(shown.find((one) => one.name === 'mine')?.how).toBe('a-program --stdio')
    expect(said).not.toContain('from-the-shell')
    expect(said).not.toContain('key')
  })

  it('says of a command that downloads its code what it does, rather than refusing it', () => {
    expect(fetchesCode('npx -y linear-mcp')).toBe(true)
    expect(fetchesCode('uvx mcp-server-git')).toBe(true)
    expect(fetchesCode('/usr/local/bin/pipx run x')).toBe(true)
    expect(fetchesCode('mcp-server-postgres')).toBe(false)
    expect(fetchesCode(null)).toBe(false)
    // And nothing the catalogue ships is one of them.
    for (const entry of CATALOGUE)
      expect(fetchesCode(entry.command ?? null), entry.name).toBe(false)
  })
})
