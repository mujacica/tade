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
