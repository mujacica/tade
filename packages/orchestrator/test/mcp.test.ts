import { readFileSync } from 'node:fs'
import { ConfigSchema } from '@tade/core'
import { ClaudeAdapter } from '@tade/harnesses-claude'
import { CodexAdapter } from '@tade/harnesses-codex'
import { WORKER_ENV } from '@tade/harnesses-core'
import { PiAdapter } from '@tade/harnesses-pi'
import { brokered } from '@tade/mcp-broker'
import { type CachedServer, nameProblem, RESERVED } from '@tade/mcp-core'
import { makeScriptedTransport } from '@tade/mcp-scripted'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { loadExtensions, writeToolList } from '../src/extensions.ts'
import { writeToolServer } from '../src/orchestrator.ts'
import { orchestratorTools } from '../src/tools-extension.ts'

// The milestone the whole design rests on: one wiring line, every harness.
//
// An MCP server somebody turned on becomes an extension whose tools are that
// server's tools, and every harness is already handed extensions' tools in
// its own terms. So this asserts the thing that would otherwise be believed
// rather than known — that a fake server's tools actually arrive at pi, at
// Claude Code, at Codex and at the orchestrator, without one adapter knowing
// MCP exists.

const catalogue = [
  {
    name: 'linear',
    title: 'Linear',
    description: 'Issues in Linear.',
    workflow: ['Ask about an issue by its number.'],
    transport: 'scripted',
  },
]

const cached: CachedServer = {
  about: { title: 'A scripted server', version: '1' },
  tools: [
    { name: 'searchIssues', description: 'Search issues.', input: { type: 'object' } },
    { name: 'createIssue', description: 'Make an issue.', input: { type: 'object' } },
  ],
  asked: '2026-09-21T08:00:00.000Z',
}

/** A home with one server turned on, and a host holding what it offers. */
async function withServer() {
  const home = tmp('tade-mcp-wire-')
  const config = ConfigSchema.parse({ mcp: { servers: { linear: { enabled: true } } } })
  const host = await loadExtensions({
    config,
    home,
    mcp: brokered({
      servers: config.mcp.servers,
      home,
      catalogue,
      transports: { scripted: () => makeScriptedTransport({ servers: { linear: {} } }) },
      cache: () => cached,
    }),
  })
  return { home, host }
}

const names = (path: string): string[] =>
  (JSON.parse(readFileSync(path, 'utf8')) as { name: string }[]).map((tool) => tool.name)

describe('a server somebody turned on', () => {
  it('is an extension beside Tade’s own, with the server’s tools in it', async () => {
    const { host } = await withServer()
    const linear = host.list().find((one) => one.source === 'mcp')
    expect(linear).toMatchObject({ name: 'mcp-linear', state: 'ready' })
    expect(host.specs('agent').map((spec) => spec.name)).toContain('mcp_linear_searchissues')
    // Tade's own are still first, and still all there.
    expect(host.list()[0]?.source).toBe('built-in')
  })

  it('is never there at all when nobody turned it on', async () => {
    const home = tmp('tade-mcp-wire-')
    const host = await loadExtensions({ config: ConfigSchema.parse({}), home })
    expect(host.list().some((one) => one.source === 'mcp')).toBe(false)
  })
})

describe('its tools, as each harness is handed them', () => {
  it('reach a pi agent, in the list pi registers its tools from', async () => {
    const { home, host } = await withServer()
    const tools = writeToolList(host, 'agent', home)
    const pi = new PiAdapter({ runDir: tmp('tade-pi-'), bin: '/pi' })
    const spec = pi.launchSpec({
      run: 'app/t/agent',
      task: 'app/t',
      cwd: tmp('tade-wt-'),
      prompt: '',
      extras: { tools },
    })
    expect(spec.env?.[WORKER_ENV.tools]).toBe(tools)
    expect(names(tools)).toContain('mcp_linear_searchissues')
  })

  it('reach a Claude Code agent, inside the one server Tade already serves it', async () => {
    const { home, host } = await withServer()
    const tools = writeToolList(host, 'agent', home)
    const claude = new ClaudeAdapter({ runDir: tmp('tade-cc-'), configDir: tmp('tade-cc-cfg-') })
    const spec = claude.launchSpec({
      run: 'app/t/agent',
      task: 'app/t',
      cwd: '/wt/t',
      prompt: '',
      extras: { tools },
    })
    const config = spec.args[spec.args.indexOf('--mcp-config') + 1] ?? ''
    const written = JSON.parse(readFileSync(config, 'utf8')) as {
      mcpServers: { tade: { env: Record<string, string> } }
    }
    // One server, Tade's own, with every brokered tool riding inside it —
    // never a second server written for somebody else's.
    expect(Object.keys(written.mcpServers)).toEqual(['tade'])
    expect(names(written.mcpServers.tade.env[WORKER_ENV.tools] ?? '')).toContain(
      'mcp_linear_searchissues',
    )
  })

  it('reach a Codex agent, through the same one server', async () => {
    const { home, host } = await withServer()
    const tools = writeToolList(host, 'agent', home)
    const codex = new CodexAdapter({ runDir: tmp('tade-cx-') })
    const spec = codex.launchSpec({
      run: 'app/t/agent',
      task: 'app/t',
      cwd: '/wt/t',
      prompt: '',
      extras: { tools },
    })
    expect(names(spec.env?.[WORKER_ENV.tools] ?? '')).toContain('mcp_linear_searchissues')
  })

  it('reach the orchestrator, whichever harness it runs in', async () => {
    const { home, host } = await withServer()
    // pi reads the same file it gives an agent.
    const tools = writeToolList(host, 'orchestrator', home)
    expect(names(tools)).toContain('mcp_linear_searchissues')
    // And a harness that speaks MCP is served them from the file Tade wrote,
    // which has to say so itself: nobody promises a harness passes its own
    // environment down to a server it spawns.
    const runDir = tmp('tade-orc-')
    const path = writeToolServer({
      home,
      runDir,
      config: ConfigSchema.parse({}),
      extensions: { prompt: '', extras: { tools } },
    } as never)
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { tade: { env: Record<string, string> } }
    }
    expect(names(written.mcpServers.tade.env[WORKER_ENV.tools] ?? '')).toContain(
      'mcp_linear_searchissues',
    )
  })
})

describe('what a brokered tool may never be called', () => {
  it('covers every tool the orchestrator has, with and without its prefix', () => {
    // The prefix rule is what actually answers; this is the fourth layer, and
    // it is here so that a tool added to `orchestratorTools` cannot come
    // loose from the list of names a server may not take.
    // Tade's own, and only those: `orchestratorTools()` also registers
    // whatever is in `TADE_EXTENSION_TOOLS`, which is the very door brokered
    // tools come through — after Tade's own, which is why they never win.
    const saved = process.env[WORKER_ENV.tools]
    delete process.env[WORKER_ENV.tools]
    const own = orchestratorTools()
    if (saved !== undefined) process.env[WORKER_ENV.tools] = saved
    for (const tool of own) {
      expect(nameProblem(tool.name), tool.name).toBeTruthy()
      // And the bare verb it is known by everywhere else — in the window, out
      // loud, in what a person types — is one a server cannot take either.
      const bare = tool.name.replace(/^tade_/, '')
      expect(RESERVED, tool.name).toContain(bare.split('_')[0])
    }
  })
})
