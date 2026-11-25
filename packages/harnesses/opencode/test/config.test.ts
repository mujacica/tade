import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { configFor, modelRef, serversIn } from '../src/config.ts'

describe('what one OpenCode run is handed', () => {
  const base = { plugin: '/tade/plugin', tools: { command: '/node', args: ['/tade/tools.ts'] } }

  it('loads Tade’s plugin and lists Tade’s tool server outside Code Mode', () => {
    expect(configFor({ ...base, gated: false })).toEqual({
      plugins: ['/tade/plugin'],
      mcp: {
        servers: {
          tade: { type: 'local', command: ['/node', '/tade/tools.ts'], codemode: false },
        },
      },
    })
  })

  it('makes every action ask under approvals, so a plugin that did not load fails closed', () => {
    const config = configFor({
      ...base,
      gated: true,
      instructions: '/run/instructions.md',
      skills: ['/skills/a'],
    })
    expect(config.permissions).toEqual([{ action: '*', resource: '*', effect: 'ask' }])
    expect(config.instructions).toEqual(['/run/instructions.md'])
    expect(config.skills).toEqual(['/skills/a'])
  })

  it('takes an extension’s MCP servers in the standard’s own file, and never in Tade’s place', () => {
    const file = join(tmp('tade-opencode-mcp-'), 'servers.json')
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          sentry: { command: 'npx', args: ['-y', 'sentry-mcp'], env: { TOKEN_FILE: '/t' } },
          docs: { url: 'https://docs.example/mcp', headers: { 'x-a': 'b' } },
          tade: { command: 'evil' },
          odd: { nothing: true },
        },
      }),
    )
    const warned: string[] = []
    expect(serversIn(file, (said) => warned.push(said))).toEqual({
      sentry: {
        type: 'local',
        command: ['npx', '-y', 'sentry-mcp'],
        environment: { TOKEN_FILE: '/t' },
      },
      docs: { type: 'remote', url: 'https://docs.example/mcp', headers: { 'x-a': 'b' } },
      tade: { type: 'local', command: ['evil'] },
    })
    expect(warned).toEqual([expect.stringContaining('odd')])
    const config = configFor({ ...base, gated: false, servers: [file] }) as {
      mcp: { servers: Record<string, unknown> }
    }
    expect(Object.keys(config.mcp.servers).sort()).toEqual(['docs', 'sentry', 'tade'])
    expect(config.mcp.servers.tade).toMatchObject({ command: ['/node', '/tade/tools.ts'] })
    expect(serversIn('/nonexistent/servers.json', (said) => warned.push(said))).toEqual({})
  })

  it('takes the `tade` it was handed as Tade’s own where there is no agent’s, outside Code Mode', () => {
    const file = join(tmp('tade-opencode-mcp-'), 'servers.json')
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { tade: { type: 'stdio', command: '/node', args: ['/mcp.ts'] } },
      }),
    )
    expect(configFor({ ...base, tools: null, gated: false, servers: [file] })).toEqual({
      plugins: ['/tade/plugin'],
      mcp: { servers: { tade: { type: 'local', command: ['/node', '/mcp.ts'], codemode: false } } },
    })
  })

  it('spells a model as OpenCode’s session takes one', () => {
    expect(modelRef('openai/gpt-5.5')).toEqual({ providerID: 'openai', id: 'gpt-5.5' })
    expect(modelRef('openrouter/anthropic/claude-sonnet-5#high')).toEqual({
      providerID: 'openrouter',
      id: 'anthropic/claude-sonnet-5',
      variant: 'high',
    })
    for (const said of ['', 'gpt-5.5', '/x', 'x/']) expect(modelRef(said)).toBeNull()
  })
})
