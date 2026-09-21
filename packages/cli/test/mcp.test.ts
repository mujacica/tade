import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const server = fileURLToPath(new URL('../../mcp/stdio/test/fixtures/server.ts', import.meta.url))
const run = promisify(execFile)

// The MCP servers from a terminal, through the real binary: listed and off,
// turned on by a person and nobody else, and one probe that actually starts a
// program and asks it what it offers.

async function tade(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const said = err as { code?: number; stdout?: string; stderr?: string }
    return { code: said.code ?? 1, stdout: said.stdout ?? '', stderr: said.stderr ?? '' }
  }
}

async function home(): Promise<{ home: string; config: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tade-mcp-cli-'))
  return { home: dir, config: join(dir, 'config.yaml') }
}

describe('tade mcp', () => {
  it('lists what Tade knows about, with every one of them off', async () => {
    const { home: dir, config } = await home()
    const listed = await tade(['mcp', 'list', '--json', '-c', config], { TADE_HOME: dir })
    expect(listed.code).toBe(0)
    const servers = JSON.parse(listed.stdout) as { name: string; on: boolean }[]
    expect(servers.length).toBeGreaterThan(5)
    // The popular ones included: a server is somebody else's code with tools
    // your agents will call.
    expect(servers.every((one) => one.on === false)).toBe(true)
    expect(servers.map((one) => one.name)).toContain('github')
  })

  it('writes one of your own down, off, and says how to turn it on', async () => {
    const { home: dir, config } = await home()
    const added = await tade(
      ['mcp', 'add', 'mine', '--transport', 'stdio', '--command', 'echo', '-c', config],
      { TADE_HOME: dir },
    )
    expect(added.code).toBe(0)
    expect(added.stdout).toContain('off')
    expect(await readFile(config, 'utf8')).toContain('command: echo')
    const listed = await tade(['mcp', 'list', '--json', '-c', config], { TADE_HOME: dir })
    const mine = (JSON.parse(listed.stdout) as { name: string; on: boolean }[]).find(
      (one) => one.name === 'mine',
    )
    expect(mine?.on).toBe(false)
  })

  it('refuses a declaration that cannot work, rather than writing it down', async () => {
    const { home: dir, config } = await home()
    const added = await tade(['mcp', 'add', 'mine', '--transport', 'stdio', '-c', config], {
      TADE_HOME: dir,
    })
    expect(added.code).toBe(2)
    expect(added.stderr).toContain('nothing says which')
    await expect(readFile(config, 'utf8')).rejects.toThrow()
  })

  it('turns one on as a setting, and says when it takes effect', async () => {
    const { home: dir, config } = await home()
    await writeFile(
      config,
      'mcp:\n  servers:\n    mine:\n      transport: stdio\n      command: echo\n',
    )
    const on = await tade(['mcp', 'enable', 'mine', '-c', config], { TADE_HOME: dir })
    expect(on.code).toBe(0)
    expect(on.stdout).toContain('next time Tade starts')
    expect(await readFile(config, 'utf8')).toContain('enabled: true')
    const off = await tade(['mcp', 'disable', 'mine', '-c', config], { TADE_HOME: dir })
    expect(off.code).toBe(0)
    expect(await readFile(config, 'utf8')).toContain('enabled: false')
  })

  it('says there is no such server rather than writing a setting for a typo', async () => {
    const { home: dir, config } = await home()
    const said = await tade(['mcp', 'enable', 'githbu', '-c', config], { TADE_HOME: dir })
    expect(said.code).toBe(2)
    expect(said.stderr).toContain('there is no server called githbu')
  })

  it('probes one, which is the only thing here that dials', async () => {
    const { home: dir, config } = await home()
    await writeFile(
      config,
      `mcp:\n  servers:\n    fixture:\n      transport: stdio\n      command: ${process.execPath}\n      args:\n        - ${server}\n        - works\n`,
    )
    const probed = await tade(['mcp', 'probe', 'fixture', '-c', config], { TADE_HOME: dir })
    expect(probed.code).toBe(0)
    expect(probed.stdout).toContain('a works server')
    expect(probed.stdout).toContain('echo')
    // What it offered is written down, which is what the first agent after a
    // restart is given.
    const cache = JSON.parse(await readFile(join(dir, 'mcp', 'fixture.json'), 'utf8')) as {
      tools: { name: string }[]
    }
    expect(cache.tools.map((one) => one.name)).toContain('told')
  })

  it('sends somebody who tried to turn a server on the extensions way to the right command', async () => {
    const { home: dir, config } = await home()
    const said = await tade(['extensions', 'enable', 'mcp-github', '-c', config], {
      TADE_HOME: dir,
    })
    expect(said.code).toBe(2)
    expect(said.stderr).toContain('tade mcp enable github')
  })
})
