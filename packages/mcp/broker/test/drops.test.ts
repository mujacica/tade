import { ExtensionHost } from '@tade/extensions-core'
import type { CachedServer, CatalogueEntry, OfferedTool } from '@tade/mcp-core'
import { makeScriptedTransport, type ScriptedServer } from '@tade/mcp-scripted'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { brokered } from '../src/index.ts'

// What is said when a brokered server stops being there.
//
// The MCP server dropping was the one thing about this feature nobody could
// find out. A program that exits between two agents' calls is reopened on the
// next one, so the only trace of it was a tool call that failed inside an
// agent — nothing in the journal, nothing on the way to Sentry, and nothing on
// screen. It is **said** when it happens now — in Tade's own words and never in
// the server's — which is what carries it to the journal and from there to
// wherever Tade's own trouble is reported.
//
// What a *brokered* server's state is drawn as is the Extensions page's and is
// tested through `ready()` below. The light along the top is about Tade's own
// MCP server, which is a different thing entirely (`view/top.ts`).

const tool = (name: string): OfferedTool => ({
  name,
  description: `Does ${name}.`,
  input: { type: 'object', properties: {} },
})

const catalogue: readonly CatalogueEntry[] = [
  {
    name: 'linear',
    title: 'Linear',
    description: 'Issues in Linear.',
    workflow: [],
    transport: 'scripted',
  },
]

const offering = (tools: readonly OfferedTool[]): CachedServer => ({
  about: { title: 'A scripted server', version: '1' },
  tools,
  asked: '2026-09-21T08:00:00.000Z',
})

/** A broker over one scripted server, and whatever it said while it worked. */
function broke(
  server: ScriptedServer,
  over: Partial<Parameters<typeof brokered>[0]> = {},
): { made: ReturnType<typeof brokered>; said: string[] } {
  const said: string[] = []
  const made = brokered({
    servers: { linear: { enabled: true } },
    home: tmp('mcp-standing-'),
    catalogue,
    transports: { scripted: () => makeScriptedTransport({ servers: { linear: server } }) },
    cache: () => offering([tool('ping')]),
    onWarning: (message) => said.push(message),
    ...over,
  })
  return { made, said }
}

/** A host over a broker's extensions, so a tool can actually be called. */
const hosting = (made: ReturnType<typeof brokered>) =>
  ExtensionHost.load({
    brokered: made.extensions,
    config: { extensions: {}, projects: {} },
    home: tmp('mcp-standing-'),
  })

const working: ScriptedServer = { tools: [tool('ping')], answers: {} }

describe('a server that drops', () => {
  it('is said with nobody having asked it anything, which is the whole point', async () => {
    // The case `onGone` exists for: a program that exits while no agent happens
    // to be calling it. Nothing polls for this — the session says so — and
    // without it the first anybody would know is an agent's tool call failing
    // an hour later, healed by the broker's one retry before it was ever seen.
    const { made, said } = broke({ ...working, goesAfterMs: 1 })
    await made.warm()
    expect(said).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(said).toEqual(['linear stopped'])
    await made.close()
  })

  it('is said when it happens, rather than at whichever agent’s call fails next', async () => {
    const { made, said } = broke({ ...working, diesAfter: 1 })
    const host = await hosting(made)
    const call = () => host.call('mcp_linear_ping', {}, { caller: { kind: 'orchestrator' } })
    await call()
    // The second call finds the server gone; the broker opens it again once,
    // so the agent making it never knows. Without this being said, neither
    // would anybody else.
    await expect(call()).resolves.toBeTruthy()
    expect(said).toEqual(['linear stopped'])
    await made.close()
  })

  it('is said once, however many agents walk into it', async () => {
    const { made, said } = broke({ ...working, diesAfter: 0 })
    const host = await hosting(made)
    const call = () => host.call('mcp_linear_ping', {}, { caller: { kind: 'orchestrator' } })
    await expect(call()).rejects.toThrow(/stopped/)
    await expect(call()).rejects.toThrow(/stopped/)
    await expect(call()).rejects.toThrow(/stopped/)
    // One drop is one finding: a server four agents are using must not become
    // four issues, and the journal is read by something that files them.
    expect(said).toEqual(['linear stopped'])
    await made.close()
  })

  it('never says what the server itself printed, only its name and why', async () => {
    const { made, said } = broke({ refuses: 'Traceback: DATABASE_URL=postgres://ash:hunter2@db' })
    await made.warm()
    const host = await hosting(made)
    const linear = host.list().find((one) => one.name === 'mcp-linear')
    // The page gets the server's own words: that is the part somebody can act
    // on, and it goes no further than the page.
    expect(linear?.problem).toContain('hunter2')
    // What is said is written to the journal and from there to wherever Tade's
    // own trouble is reported. A server's output is not Tade's to send — it is
    // somebody's database, somebody's stack, somebody's token.
    expect(said.join(' ')).toContain('linear would not start')
    expect(said.join(' ')).not.toContain('hunter2')
    expect(said.join(' ')).not.toContain('Traceback')
    await made.close()
  })

  it('says nothing about a session Tade itself closed', async () => {
    const { made, said } = broke(working)
    await made.warm()
    await made.close()
    // Closing the window ends every session. Reported, that is an issue filed
    // every time anybody quits.
    expect(said).toEqual([])
  })

  it('is never worse than the drop it is about, when saying it is what fails', async () => {
    const { made } = broke(
      { ...working, diesAfter: 0 },
      {
        onWarning: () => {
          throw new Error('the journal would not take it')
        },
      },
    )
    const host = await hosting(made)
    // Where this is said from is a child's exit handler and a failing tool
    // call: a throw is an uncaught exception in the first — every agent in the
    // checkout, under the `pty` driver — and in the second it would replace the
    // server's own reason with whoever could not write it down.
    await expect(
      host.call('mcp_linear_ping', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/stopped/)
    await made.close()
  })

  it('is not troubled by a call the server itself refused, which is about the call', async () => {
    const { made, said } = broke(working)
    await made.warm()
    const host = await hosting(made)
    await expect(
      host.call('mcp_linear_ping', { nope: true }, { caller: { kind: 'orchestrator' } }),
    ).resolves.toBeTruthy()
    // A server answering "no" is an answer a model reads and routes around.
    // Counted against the server it would light a lamp for every bad query.
    expect(said).toEqual([])
    await made.close()
  })
})
