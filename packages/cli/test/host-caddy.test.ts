import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CertificateLook,
  caddySite,
  PUBLIC_IS_THE_INTERNET,
  TADE_SH_IS_THE_INSTALLER,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { caddySaid, type Looking, lookAtPublic } from '../src/commands/host-caddy.ts'

// `tade host caddy`: the block alone on standard output, every other step
// beside it, and `--check`'s look — which is handed its own certificate and
// update answer here, because a test may never reach the network it runs on.

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 16)
const NAME = 'tade.example.com'
const SOCKET = '/run/tade/away.sock'
const RIGHT = { directory: true, uid: 1000, mode: 0o42750 }

describe('what is said beside the block', () => {
  it('says what a public name is first, then each step in the order it is done', () => {
    const said = caddySaid({
      name: NAME,
      configured: '',
      user: 'you',
      socket: SOCKET,
      dir: null,
      uid: 1000,
    }).join('\n')
    expect(said).toContain(PUBLIC_IS_THE_INTERNET)
    expect(said).toContain("printf 'd /run/tade 2750 %s caddy -\\n' you | sudo tee")
    expect(said).toContain('now: /run/tade is not there, so nothing listens for Caddy')
    expect(said).toContain('sudo systemctl reload caddy')
    expect(said).toContain(`An A record for ${NAME}`)
    expect(said).toContain(`domain ${NAME}\` looks at each and says exactly what to add`)
    expect(said).toContain(`Set surfaces.web.public to ${NAME}`)
    const order = ['1. ', '2. ', '3. ', '4. '].map((step) => said.indexOf(step))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('says the directory is right where it is, and that the name is already set where it is', () => {
    const said = caddySaid({
      name: NAME,
      configured: NAME,
      user: 'you',
      socket: SOCKET,
      dir: RIGHT,
      uid: 1000,
    }).join('\n')
    expect(said).toContain('/run/tade is there, and right.')
    expect(said).toContain(`surfaces.web.public is ${NAME}`)
  })
})

describe('the look from here', () => {
  const looking = (over: Partial<Looking> = {}): Looking => ({
    name: NAME,
    socket: SOCKET,
    uid: 1000,
    dir: RIGHT,
    answering: async () => true,
    look: async (): Promise<CertificateLook> => ({
      at: NOW,
      seen: {
        validFrom: NOW - 30 * DAY,
        validTo: NOW + 60 * DAY,
        issuer: "Let's Encrypt",
        authorized: true,
        error: null,
      },
    }),
    newer: async () => ({ newer: null }),
    now: NOW,
    ...over,
  })

  it('is quiet when all four are right', async () => {
    const said = await lookAtPublic(looking())
    expect(said.map((one) => one.loud)).toEqual([false, false, false])
    expect(said.map((one) => one.said)).toEqual([
      `Tade is listening for Caddy at ${SOCKET}`,
      "certificate: 60 days left, until 2026-12-15, from Let's Encrypt",
      'Tade is not behind, as of the last update check',
    ])
  })

  it('is loud about a directory, a socket nobody listens on, a certificate and a version', async () => {
    const said = await lookAtPublic(
      looking({
        dir: null,
        look: async () => ({ at: NOW, cannot: 'ENOTFOUND' }),
        newer: async () => ({ newer: '0.2.4 is out' }),
      }),
    )
    expect(said.every((one) => one.loud)).toBe(true)
    expect(said[0]?.said).toContain('/run/tade is not there')
    const idle = await lookAtPublic(looking({ answering: async () => false }))
    expect(idle[0]).toMatchObject({ loud: true })
    expect(idle[0]?.said).toContain(`nothing listens at ${SOCKET}`)
  })

  it('cannot tell whether Tade is behind where nothing has asked, and does not guess', async () => {
    const said = await lookAtPublic(looking({ newer: async () => null }))
    expect(said[2]).toEqual({
      said: 'whether Tade is behind cannot be told: nothing here has asked — `tade update --check` asks',
      loud: false,
    })
  })
})

describe('tade host caddy', () => {
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const dir = tmp('tade-caddy-cli-')
      const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, TADE_HOME: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })

  it('prints the block and nothing else on standard output, for a name it is given', async () => {
    const result = await run(['host', 'caddy', 'Tade.Example.com'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(caddySite(NAME))
    expect(result.stderr).toContain(`Set surfaces.web.public to ${NAME}`)
  })

  it('refuses what is not a name, and says how to give one where there is none', async () => {
    const none = await run(['host', 'caddy'])
    expect(none.code).toBe(2)
    expect(none.stdout).toBe('')
    expect(none.stderr).toContain('No public name')
    const url = await run(['host', 'caddy', 'https://tade.example.com'])
    expect(url.code).toBe(2)
    expect(url.stderr).toContain('is not a host name')
    const installer = await run(['host', 'caddy', 'vps.tade.sh'])
    expect(installer.code).toBe(2)
    expect(installer.stdout).toBe('')
    expect(installer.stderr).toContain(TADE_SH_IS_THE_INSTALLER)
  })
})
