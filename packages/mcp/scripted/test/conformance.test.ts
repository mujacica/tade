import type { OfferedTool, ServerDeclaration } from '@tade/mcp-core'
import { testTransport } from '@tade/mcp-core/conformance'
import { describe, expect, it } from 'vitest'
import { makeScriptedTransport, type ScriptedServer } from '../src/index.ts'

// The scripted transport against the suite every transport passes — which is
// also what proves the suite itself is satisfiable before the first real one
// is written.

const tool = (name: string): OfferedTool => ({
  name,
  description: `Does ${name}.`,
  input: { type: 'object', properties: {} },
})

const declare = (name: string, over: Partial<ServerDeclaration> = {}): ServerDeclaration => ({
  name,
  transport: 'scripted',
  enabled: true,
  about: '',
  command: null,
  args: [],
  url: null,
  env: {},
  header: {},
  auth: 'none',
  authName: null,
  variables: [],
  tools: [],
  scope: 'window',
  install: null,
  ...over,
})

const servers: Record<string, ScriptedServer> = {
  works: {
    about: { title: 'A scripted server', version: '1' },
    tools: [tool('search'), tool('fails'), tool('lingers')],
    answers: {
      search: { text: 'two issues', failed: false },
      fails: { text: 'the query was not understood', failed: true },
    },
  },
  missing: { problem: 'scripted-mcp is not on this machine: it never was' },
  hangs: { hangs: true },
  noisy: {
    // What a server that answers with things nothing here recognises looks
    // like: the good ones come back, and nothing throws over the rest.
    tools: [tool('good'), null as never, { name: 'x' } as never],
  },
  // One that never survives a call: what a crashed program and a forgotten
  // session both look like to whoever is holding the session.
  dying: { tools: [tool('search')], diesAfter: 0 },
}

const slow: Record<string, ScriptedServer> = {
  ...servers,
  works: { ...servers.works, ms: 5_000 },
}

testTransport('scripted', () => makeScriptedTransport({ servers }), {
  works: declare('works'),
  fails: 'fails',
  missing: declare('missing'),
  hangs: declare('hangs'),
  noisy: declare('noisy'),
  dies: { server: declare('dying'), tool: 'search' },
})

describe('the scripted transport', () => {
  it('is a table and nothing else: it starts nothing and reaches nothing', () => {
    const transport = makeScriptedTransport()
    expect(transport.capabilities.spawns).toBe(false)
    expect(transport.capabilities.network).toBe(false)
  })

  it('gives up on a call it is told to give up on, rather than leaving an agent waiting', async () => {
    const session = await makeScriptedTransport({ servers: slow }).open(declare('works'), context())
    const controller = new AbortController()
    const call = session.callTool('search', {}, { signal: controller.signal, progress: () => {} })
    controller.abort()
    await expect(call).rejects.toMatchObject({ trouble: 'refused' })
    await session.close()
  })

  it('is alive again when it is opened again, which is what a retry is for', async () => {
    // A server that dies on every call still gives a working session on the
    // next open: the count is the session's, not the server's, so the broker
    // has something to retry onto rather than a table that stays dead.
    const transport = makeScriptedTransport({
      servers: { ...servers, works: { ...servers.works, diesAfter: 1 } },
    })
    const first = await transport.open(declare('works'), context())
    const calling = { signal: new AbortController().signal, progress: () => {} }
    expect((await first.callTool('search', {}, calling)).text).toBe('two issues')
    await expect(first.callTool('search', {}, calling)).rejects.toMatchObject({ trouble: 'gone' })
    const second = await transport.open(declare('works'), context())
    expect((await second.callTool('search', {}, calling)).text).toBe('two issues')
    await first.close()
    await second.close()
  })

  it('says its tool list changed, which is what reaches the next agent', async () => {
    const session = await makeScriptedTransport({
      servers: { ...servers, works: { ...servers.works, changesAfterMs: 1 } },
    }).open(declare('works'), context())
    const said = await new Promise<boolean>((resolve) => {
      const stop = session.onToolsChanged(() => {
        stop()
        resolve(true)
      })
      const timer = setTimeout(() => resolve(false), 1_000)
      timer.unref?.()
    })
    expect(said).toBe(true)
    await session.close()
  })
})

function context() {
  return {
    home: '/nonexistent',
    credential: null,
    env: {},
    fetch: (async () => {
      throw new Error('the scripted transport reached the network')
    }) as unknown as typeof fetch,
    now: () => 0,
    deadlineMs: 200,
  }
}
