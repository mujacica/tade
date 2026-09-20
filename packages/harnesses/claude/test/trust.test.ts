import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { defaultConfigDir } from '../src/transcript.ts'
import { stateFileFor, trustFolder } from '../src/trust.ts'

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('trusting a folder for Claude Code', () => {
  it('keeps the answer beside the default account, and inside any other', () => {
    const home = '/Users/someone'
    expect(stateFileFor(defaultConfigDir(home), home)).toBe('/Users/someone/.claude.json')
    expect(stateFileFor('/elsewhere/work', home)).toBe('/elsewhere/work/.claude.json')
  })

  it('says yes for the folder, by its real path, and leaves everything else as it was', async () => {
    const account = tmp('tade-claude-account-')
    const folder = tmp('tade-claude-work-')
    const file = join(account, '.claude.json')
    writeFileSync(
      file,
      JSON.stringify({ oauthAccount: { email: 'x' }, projects: { '/a': { n: 1 } } }),
      {
        mode: 0o600,
      },
    )
    expect(await trustFolder(folder, account)).toBe(true)
    const state = read(file)
    expect(state.projects[folder]).toEqual({ hasTrustDialogAccepted: true })
    expect(state.projects['/a']).toEqual({ n: 1 })
    expect(state.oauthAccount).toEqual({ email: 'x' })
    // Its sign-in lives there: never made readable to anybody else.
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // Asked again, nothing to do.
    expect(await trustFolder(folder, account)).toBe(false)
  })

  it('writes one for an account that has none yet, and marks first-run done when asked', async () => {
    const account = tmp('tade-claude-account-')
    const folder = tmp('tade-claude-work-')
    await trustFolder(folder, account, { firstRun: true })
    expect(read(join(account, '.claude.json'))).toMatchObject({
      hasCompletedOnboarding: true,
      projects: { [folder]: { hasTrustDialogAccepted: true } },
    })
  })

  it('waits for Claude Code’s own lock, and takes over one long abandoned', async () => {
    const account = tmp('tade-claude-account-')
    const folder = tmp('tade-claude-work-')
    const lock = join(account, '.claude.json.lock')
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(await trustFolder(folder, account)).toBe(true)
    // Given back.
    expect(() => statSync(lock)).toThrow()
  })

  it('gives up on a lock someone is holding rather than writing under them', async () => {
    const account = tmp('tade-claude-account-')
    mkdirSync(join(account, '.claude.json.lock'))
    await expect(trustFolder(tmp('tade-claude-work-'), account)).rejects.toThrow(/held/)
  }, 10_000)
})
