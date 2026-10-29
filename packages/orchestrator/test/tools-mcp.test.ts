import { spawn } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { orchestratorExtensions } from '../src/extensions.ts'
import { TOOLS_MCP, writeToolServer } from '../src/orchestrator.ts'
import { ToolHost } from '../src/tool-host.ts'

// Tade's tools as a harness that speaks MCP is handed them: not the list the
// code could build, but the server started from the bytes Tade wrote, with
// nothing of this process's environment behind it.
//
// That last part is the whole point. The tools reach an orchestrator on
// Claude Code through a server Claude Code spawns from this file. It passes
// its own environment down today, but a harness that did not would leave
// anything the server needs and the file does not say a tool that quietly is
// not there — and the file says nothing else (`toolsTold`), so no key. An
// orchestrator on Claude Code with fewer tools than one on pi is a capability
// difference nobody declared.

async function until(check: () => boolean, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe("Tade's tools over MCP", () => {
  let tade: Workbench
  let tools: ToolHost
  let home: string
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-mcp-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    tade = await Workbench.open({ home })
  })

  afterEach(async () => {
    await tools?.close().catch(() => {})
    await tade.close().catch(() => {})
  })

  it("serves the extensions' tools beside Tade's own, and runs them in Tade", async () => {
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          tools: [
            {
              name: 'weather_now',
              description: 'Is it raining where a project lives.',
              parameters: { type: 'object', properties: { project: { type: 'string' } } },
              for: ['orchestrator'],
              run: async (input) => ({ text: `Raining over ${String(input.project)}.` }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      extensions: async (call) =>
        (
          await extensions.call(call.tool, call.input, {
            caller: { kind: 'orchestrator' },
            id: call.callId,
          })
        ).text,
    })

    const runDir = tmp('tade-mcp-run-')
    const written = writeToolServer({
      home,
      socket: tools.path,
      runDir,
      config: ConfigSchema.parse({
        orchestrator: { harness: 'claude-code' },
        projects: { app: { root: repo.root } },
      }),
      extensions: orchestratorExtensions(extensions, home, 'claude-code'),
    })
    const server = (
      JSON.parse(readFileSync(written, 'utf8')) as {
        mcpServers: { tade: { command: string; args: string[]; env: Record<string, string> } }
      }
    ).mcpServers.tade

    // Started with what the file says and nothing else: whatever a harness
    // would have lent it, it does not get here.
    const child = spawn(server.command, server.args, { env: server.env, stdio: 'pipe' })
    const answers: Array<{ id: number; result: Record<string, unknown> }> = []
    let rest = ''
    child.stdout.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        answers.push(JSON.parse(rest.slice(0, end)))
        rest = rest.slice(end + 1)
      }
    })
    try {
      for (const line of [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'weather_now', arguments: { project: 'app' } },
        },
      ]) {
        child.stdin.write(`${JSON.stringify(line)}\n`)
      }
      await until(() => answers.length === 3)
    } finally {
      child.kill()
    }

    const by = (id: number) => answers.find((answer) => answer.id === id)?.result
    const listed = ((by(2)?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name)
    // Tade's own, and the extension's, in one list: two lists would be two
    // tool surfaces, and the golden file would protect only one of them.
    expect(listed).toContain('tade_status')
    expect(listed).toContain('weather_now')
    // And it is the window that runs it, which is where the extension lives.
    expect(by(3)).toEqual({
      content: [{ type: 'text', text: 'Raining over app.' }],
      isError: false,
    })
  }, 60_000)

  /**
   * The server as Claude Code starts it, from a folder of its own where the
   * tools beside it are `tools` — so what the server does when they cannot be
   * loaded, or break later, is shown rather than argued.
   */
  async function serveBeside(source: string) {
    const dir = tmp('tade-mcp-beside-')
    copyFileSync(TOOLS_MCP, join(dir, 'tools-mcp.ts'))
    writeFileSync(join(dir, 'tools-extension.ts'), source)
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
    const host = await ToolHost.listen({ tade, path: join(home, 'tools.sock') })
    tools = host
    const child = spawn(process.execPath, [join(dir, 'tools-mcp.ts')], {
      env: { PATH: process.env.PATH ?? '', TADE_SOCKET: host.path, TADE_HOME: home },
      stdio: 'pipe',
    })
    const answers: Array<{
      id: number
      result?: Record<string, unknown>
      error?: { message: string }
    }> = []
    let rest = ''
    child.stdout.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        answers.push(JSON.parse(rest.slice(0, end)))
        rest = rest.slice(end + 1)
      }
    })
    let exited: number | null | undefined
    child.on('exit', (code) => {
      exited = code
    })
    const ask = (id: number, method: string, params: Record<string, unknown> = {}) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    /** What has been written down as a warning, once anything has. */
    const warnings = async (): Promise<string[]> => {
      const deadline = Date.now() + 30_000
      for (;;) {
        const said = (await tade.events({ types: ['warning'] })).map((event) =>
          String((event.detail as { message?: unknown }).message),
        )
        if (said.length > 0 || Date.now() > deadline) return said
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    return { child, answers, ask, warnings, exited: () => exited }
  }

  it('answers the handshake without its tools, and says why there are none', async () => {
    // Claude Code gives up on a server for the whole session if `initialize`
    // is late, so the handshake may not wait on loading the tools — shown by
    // tools that never load at all.
    const served = await serveBeside("throw new Error('broken on purpose')\n")
    try {
      served.ask(1, 'initialize', { protocolVersion: '2025-06-18' })
      await until(() => served.answers.length === 1)
      expect(served.answers[0]?.result).toMatchObject({ serverInfo: { name: 'tade' } })

      served.ask(2, 'tools/list')
      served.ask(3, 'tools/call', { name: 'tade_status', arguments: {} })
      await until(() => served.answers.length === 3)
      const by = (id: number) => served.answers.find((answer) => answer.id === id)
      // An error and never an empty list: no tools reads as a server that has none.
      expect(by(2)?.error?.message).toBe("Tade's own tools could not be loaded: broken on purpose")
      expect(by(3)?.result).toEqual({
        content: [
          { type: 'text', text: "Tade's own tools could not be loaded: broken on purpose" },
        ],
        isError: true,
      })
      // And written down where Tade's own trouble goes, once.
      const said = await served.warnings()
      expect(said).toHaveLength(1)
      // Where it broke, which is the line the module threw on.
      expect(said[0]).toMatch(
        /^the orchestrator's tools: Tade's own tools could not be loaded: broken on purpose \(at .*tools-extension\.ts:1:/,
      )
    } finally {
      served.child.kill()
    }
  }, 60_000)

  it('reports a crash of its own to the window, and ends', async () => {
    // A throw nobody catches, from a tool that has already answered: the
    // process is in a state nobody chose, so it ends — and says why first.
    const served = await serveBeside(
      [
        'export function orchestratorTools() {',
        '  return [{ name: "tade_status", label: "", description: "", parameters: {},',
        '    run: async () => { setTimeout(() => { throw new Error("broke after answering") }); return "fine" } }]',
        '}',
        '',
      ].join('\n'),
    )
    try {
      served.ask(1, 'initialize', { protocolVersion: '2025-06-18' })
      served.ask(2, 'tools/call', { name: 'tade_status', arguments: {} })
      await until(() => served.exited() !== undefined)
      expect(served.exited()).toBe(1)
      expect(served.answers.find((answer) => answer.id === 2)?.result).toMatchObject({
        isError: false,
      })
      const said = await served.warnings()
      expect(said).toHaveLength(1)
      expect(said[0]).toMatch(/^the orchestrator's tools: broke after answering \(at /)
    } finally {
      served.child.kill()
    }
  }, 60_000)
})
