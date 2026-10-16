import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { signedInUntil } from '../src/login.ts'

// A Claude Code sign-in on a server: the same `claude auth login`, which with
// no browser prints a link and asks for the code back — and how long the login
// has left, because an agent that outlives it on a machine nobody is watching
// stops making progress.

const DAY = 86_400_000

/** A Claude Code folder holding a sign-in that runs out when it is told to. */
function folder(oauth: Record<string, unknown> | string): string {
  const dir = tmp('tade-claude-login-')
  const text = typeof oauth === 'string' ? oauth : JSON.stringify({ claudeAiOauth: oauth })
  writeFileSync(join(dir, '.credentials.json'), text)
  return dir
}

describe('how long a sign-in has left', () => {
  const now = Date.now()

  it('is the refresh token’s end, which is what Claude Code counts its warning down from', async () => {
    const dir = folder({
      accessToken: 'a',
      expiresAt: now + 8 * 3_600_000,
      refreshTokenExpiresAt: now + 30 * DAY,
    })
    expect(await signedInUntil(dir, 'linux')).toBe(now + 30 * DAY)
  })

  it('is the access token’s end where that outlasts the refresh token', async () => {
    const dir = folder({ expiresAt: now + 365 * DAY, refreshTokenExpiresAt: now + DAY })
    expect(await signedInUntil(dir, 'linux')).toBe(now + 365 * DAY)
  })

  it('cannot tell where nothing was written down, or what was is not a sign-in', async () => {
    expect(await signedInUntil(tmp('tade-claude-none-'), 'linux')).toBeNull()
    expect(await signedInUntil(folder({ scopes: [] }), 'linux')).toBeNull()
    expect(await signedInUntil(folder('{not json'), 'linux')).toBeNull()
  })

  it('never opens the Keychain, which is where a Mac keeps it — even with a file left over', async () => {
    const dir = folder({ refreshTokenExpiresAt: now + 30 * DAY })
    expect(await signedInUntil(dir, 'darwin')).toBeNull()
  })

  it('is what the account says, beside who it is signed in as', async () => {
    const dir = folder({ refreshTokenExpiresAt: now + 12 * DAY })
    const bin = join(tmp('tade-claude-bin-'), 'claude')
    writeFileSync(
      bin,
      `#!/bin/sh\necho '${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'you@example.com', subscriptionType: 'max' })}'\n`,
    )
    chmodSync(bin, 0o755)
    const adapter = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: dir, bin })
    expect(await adapter.account()).toMatchObject({
      signedIn: true,
      who: 'you@example.com',
      until: process.platform === 'darwin' ? null : now + 12 * DAY,
    })
  })
})

describe('signing in on a machine with no screen', () => {
  it('runs the same command, and says the link opens anywhere and the code comes back here', () => {
    const adapter = new ClaudeAdapter({ runDir: tmp('tcc-') })
    const here = adapter.signIn({ browser: true })
    const server = adapter.signIn({ browser: false })
    expect(server?.launch).toEqual(here?.launch)
    expect(here?.how).toContain('opens your browser')
    expect(server?.how).toContain('open it on any device')
    expect(server?.how).toContain('paste the code it gives you back here')
  })
})
