import { describe, expect, it } from 'vitest'
import { mkrepo, runGit } from '../../../test/fixtures/mkrepo.ts'
import { forgeFor } from '../src/forges.ts'
import { probeGit } from '../src/git.ts'

const exec = async () => ({ code: 1, stdout: '', stderr: 'not here' })

describe('which forge serves a remote', () => {
  it('picks the one that says it does, however the remote is written', () => {
    for (const remote of [
      'git@github.com:acme/api.git',
      'https://github.com/acme/api',
      'ssh://git@github.com/acme/api.git',
    ]) {
      expect(forgeFor(remote, { exec })?.id).toBe('github')
    }
  })

  it('is nobody for a remote no forge claims — a repository Tade only reads git from', () => {
    expect(forgeFor('/srv/git/bare.git', { exec })).toBeNull()
    expect(forgeFor('git@git.example.invalid:acme/api.git', { exec })).toBeNull()
  })

  it('takes the config\u2019s word for an enterprise host', () => {
    const forge = forgeFor('git@git.acme.com:acme/api.git', {
      exec,
      hostForges: { 'git.acme.com': 'github' },
    })
    expect(forge?.id).toBe('github')
    expect(forge?.serves('git@git.acme.com:acme/api.git')).toBe(true)
  })

  it('picks one for a remote that names a second account over an ssh alias', () => {
    // `git@github.com-ammujacic:…` is a second GitHub account's repository,
    // reached over an alias in `~/.ssh/config`. Before this, no forge claimed
    // it at all, so a real project read as one Tade only reads git from.
    const remote = 'git@github.com-ammujacic:ammujacic/zahlenzauber.git'
    const forge = forgeFor(remote, { exec })
    expect(forge?.id).toBe('github')
    expect(forge?.placeOf(remote)).toEqual({ host: 'github.com', account: 'ammujacic' })
  })

  it('hands back a forge already asking as the account the remote names', async () => {
    // The whole point of binding it here: every caller above — the branch
    // watch, the review watches, `checksOn`, the tools — gets the right
    // account without being handed a remote, because there is one place that
    // reads the declaration.
    const asked: string[][] = []
    const recording = async (_command: string, args: readonly string[]) => {
      asked.push([...args])
      return { code: 1, stdout: '', stderr: 'no accounts matched' }
    }
    const forge = forgeFor('git@github.com-ammujacic:ammujacic/zahlenzauber.git', {
      exec: recording,
    })
    await forge?.whoami()
    expect(asked).toContainEqual([
      'auth',
      'token',
      '--hostname',
      'github.com',
      '--user',
      'ammujacic',
    ])
  })

  it('lets the project\u2019s own word beat the machine\u2019s setting for the host', async () => {
    // `accounts` in the config is about a host, and cannot know that one
    // repository on it belongs to a second account. The remote says exactly
    // that, so it wins.
    const asked: string[][] = []
    const recording = async (_command: string, args: readonly string[]) => {
      asked.push([...args])
      return { code: 1, stdout: '', stderr: 'no accounts matched' }
    }
    const forge = forgeFor('git@github.com-ammujacic:ammujacic/zahlenzauber.git', {
      exec: recording,
      accounts: { 'github.com': 'mujacica' },
    })
    await forge?.whoami()
    expect(asked.at(-1)?.at(-1)).toBe('ammujacic')
  })

  it('refuses a host pointed at a forge nobody registered rather than guessing', () => {
    expect(
      forgeFor('git@git.acme.com:acme/api.git', { exec, hostForges: { 'git.acme.com': 'gitlab' } }),
    ).toBeNull()
  })
})

describe('the review a branch is out for', () => {
  it('is nothing at all when there is no remote, and asks nobody', async () => {
    const repo = mkrepo()
    const probed = await probeGit(repo.root, { baseRef: null, pr: true })
    expect(probed.snapshot?.pr).toBeNull()
    expect(probed.warnings).toEqual([])
  })

  it('is nothing when the remote belongs to no forge', async () => {
    const repo = mkrepo()
    runGit(repo.root, 'remote', 'add', 'origin', '/srv/git/bare.git')
    const probed = await probeGit(repo.root, { baseRef: null, pr: true })
    expect(probed.snapshot?.pr).toBeNull()
  })
})
