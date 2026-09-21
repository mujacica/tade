import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { orchestratorExtensions } from '../src/extensions.ts'
import { writeToolServer } from '../src/orchestrator.ts'
import { ToolHost } from '../src/tool-host.ts'

// Tade's tools as a harness that speaks MCP is handed them: not the list the
// code could build, but the server started from the bytes Tade wrote, with
// nothing of this process's environment behind it.
//
// That last part is the whole point. The tools reach an orchestrator on
// Claude Code through a server Claude Code spawns from this file, and nobody
// promises it passes its own environment down — so anything the server needs
// and the file does not say is a tool that quietly is not there. An
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
})
