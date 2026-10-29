import { readFileSync } from 'node:fs'
import { ConfigSchema } from '@tade/core'
import { ClaudeAdapter } from '@tade/harnesses-claude'
import { CodexAdapter } from '@tade/harnesses-codex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { writeToolServer } from '../src/orchestrator.ts'

// No key in a file Tade writes for a harness, nor on the line it launches one
// with (`withoutInherited`, `secretCommand`). The orchestrator's
// `tade-tools.mcp.json` once held the whole environment the window was opened
// from — every key the shell exported. A server is told what Tade's tools
// need; the rest it inherits from the harness that spawns it. Codex says the
// `env` of any file it is handed again on its command line, so a file is
// checked there too.
//
// Planted both where Tade is handed an environment and in this process's own,
// so a writer that reaches for `process.env` directly is caught too. Only the
// names are ever printed: a failure here must not be the leak it is about.

const SECRET_SHAPE = /KEY|TOKEN|SECRET|PASS(WORD|WD)?|CREDENTIAL|AUTH|DSN|PRIVATE/i

const PLANTED: Record<string, string> = {
  PLANTED_API_KEY: 'planted-value-api-key-6f1c',
  PLANTED_TOKEN: 'planted-value-token-a93e',
  PLANTED_CLIENT_SECRET: 'planted-value-secret-27d0',
  PLANTED_PASSWORD: 'planted-value-password-c41b',
  PLANTED_REFRESH_TOKEN: 'planted-value-refresh-8be5',
}

/** The variable names a written server is handed that look like a credential. */
function secretShaped(env: Record<string, unknown> | undefined): string[] {
  return Object.keys(env ?? {}).filter((name) => SECRET_SHAPE.test(name))
}

/** The planted names whose value turns up anywhere in `text`. */
function leakedInto(text: string): string[] {
  return Object.entries(PLANTED)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name)
}

type Servers = Record<string, { env?: Record<string, unknown> }>

describe('a written MCP config', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [name, value] of Object.entries(PLANTED)) {
      saved[name] = process.env[name]
      process.env[name] = value
    }
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  function orchestratorFile(): string {
    return writeToolServer({
      home: tmp('tade-mcp-keys-'),
      socket: '/tade/tools.sock',
      runDir: tmp('tade-mcp-keys-run-'),
      config: ConfigSchema.parse({}),
      env: { ...process.env, ...PLANTED, PATH: '/usr/bin' },
      extensions: { prompt: '', extras: { tools: '/tools.json' } },
    } as never)
  }

  it('the orchestrator is handed holds what its tools need and no key', () => {
    const text = readFileSync(orchestratorFile(), 'utf8')
    const servers = (JSON.parse(text) as { mcpServers: Servers }).mcpServers
    for (const server of Object.values(servers)) expect(secretShaped(server.env)).toEqual([])
    expect(leakedInto(text)).toEqual([])
    // Only what the tools read — the rest is the spawning harness's to pass on.
    expect(Object.keys(servers.tade?.env ?? {}).sort()).toEqual([
      'TADE_CLI',
      'TADE_CLI_ARGS',
      'TADE_EXTENSIONS',
      'TADE_EXTENSION_TOOLS',
      'TADE_HOME',
      'TADE_SKILLS',
      'TADE_SOCKET',
    ])
  })

  it('a Claude Code agent is handed holds no key', () => {
    const one = new ClaudeAdapter({
      runDir: tmp('tade-mcp-keys-claude-'),
      configDir: tmp('tade-mcp-keys-claude-config-'),
      env: { ...process.env, ...PLANTED },
    })
    const launch = one.launchSpec({
      run: 'app/t/agent',
      task: 'app/t',
      cwd: '/wt/t',
      prompt: '',
      extras: { tools: '/tools.json' },
    })
    const text = readFileSync(launch.args[launch.args.indexOf('--mcp-config') + 1] ?? '', 'utf8')
    const servers = (JSON.parse(text) as { mcpServers: Servers }).mcpServers
    for (const server of Object.values(servers)) expect(secretShaped(server.env)).toEqual([])
    expect(leakedInto(text)).toEqual([])
    expect(leakedInto(launch.args.join('\n'))).toEqual([])
  })

  it('Codex is handed on its command line holds no key, the orchestrator’s included', () => {
    const one = new CodexAdapter({
      runDir: tmp('tade-mcp-keys-codex-'),
      codexHome: tmp('tade-mcp-keys-codex-home-'),
      home: tmp('tade-mcp-keys-codex-user-'),
      bin: 'codex',
      env: { ...process.env, ...PLANTED },
    })
    const launch = one.launchSpec({
      run: 'app/t/agent',
      task: 'app/t',
      cwd: '/wt/t',
      prompt: '',
      // A file Tade wrote, which Codex says again as `-c mcp_servers=…`.
      extras: { tools: '/tools.json', mcp: [orchestratorFile()] },
    })
    expect(leakedInto(launch.args.join('\n'))).toEqual([])
    // Names alone, in the servers' table: the line's own script names the
    // account's key variables, which it reads when it runs (`secretCommand`).
    const servers = launch.args.find((arg) => arg.startsWith('mcp_servers=')) ?? ''
    expect(servers).toContain('"tade"')
    const names = [...servers.matchAll(/"?([A-Z][A-Z0-9_]*)"?\s*=/g)].map((match) => match[1] ?? '')
    expect(names).toContain('TADE_RUN_SOCKET')
    expect(names.filter((name) => SECRET_SHAPE.test(name))).toEqual([])
  })
})
