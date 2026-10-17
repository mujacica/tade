import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { CREDENTIAL_KEEP_MS, type ForgeOptions } from '@tade/forges-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { forgeExec, forgeFor, remoteAt } from '../src/forges.ts'
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

  it('hands a forge the App made on the host its remote goes to, and none for another', async () => {
    const app = { host: 'github.com', id: '4242', key: 'not a key' }
    // A forge made with the App signs for itself before it reads, so a key
    // that is not one is how the test sees which forge was given it.
    const asked = (remote: string, hostForges: Record<string, string> = {}) =>
      forgeFor(remote, { exec, apps: [app], hostForges, fetch: async () => new Response('[]') })
        ?.checksOn('acme/api', 'a'.repeat(40))
        .then(
          () => 'as the person',
          (err: unknown) => (String(err).includes('GitHub App 4242') ? 'as the App' : String(err)),
        )
    expect(await asked('git@github.com:acme/api.git')).toBe('as the App')
    expect(await asked('git@github.com-work:acme/api.git')).toBe('as the App')
    expect(await asked('git@git.acme.com:acme/api.git', { 'git.acme.com': 'github' })).not.toBe(
      'as the App',
    )
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

describe('what the registry keeps between looks', () => {
  // A forge is made for every look. Before these, each one ran `gh auth token`
  // and `git config --get remote.origin.url` again: two processes a minute per
  // project, for answers that change when somebody signs in or edits a remote.

  it('asks gh once for every forge made for the same sign-in through one way of running it', async () => {
    let asked = 0
    const signedIn: ForgeOptions['exec'] = async (command) => {
      if (command === 'gh') asked++
      return { code: 0, stdout: 'gho_kepttoken\n', stderr: '' }
    }
    const fetch = (async () =>
      new Response(JSON.stringify({ login: 'kept' }), { status: 200 })) as typeof globalThis.fetch
    for (let look = 0; look < 3; look++) {
      await forgeFor('git@github.com:acme/api.git', { exec: signedIn, fetch, env: {} })?.whoami()
    }
    expect(asked).toBe(1)
    // A second account is a second sign-in, so it is its own ask.
    await forgeFor('git@github.com-ammujacic:ammujacic/z.git', {
      exec: signedIn,
      fetch,
      env: {},
    })?.whoami()
    expect(asked).toBe(2)
  })

  it('reads a remote once while the config it is written in is unchanged', async () => {
    const repo = mkrepo()
    runGit(repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/api.git')
    const { exec, asked } = counting()
    expect(await remoteAt(exec, repo.root)).toBe('git@github.com:acme/api.git')
    expect(await remoteAt(exec, repo.root)).toBe('git@github.com:acme/api.git')
    expect(asked()).toBe(1)
    runGit(repo.root, 'remote', 'set-url', 'origin', 'git@github.com:acme/moved.git')
    expect(await remoteAt(exec, repo.root)).toBe('git@github.com:acme/moved.git')
    expect(asked()).toBe(2)
  })

  it('reads a worktree\u2019s remote from the repository\u2019s config, and sees it change there', async () => {
    const repo = mkrepo()
    repo.write({ 'a.txt': 'a' })
    runGit(repo.root, 'add', '.')
    runGit(repo.root, 'commit', '-qm', 'a')
    runGit(repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/api.git')
    const tree = join(tmp('tade-remote-tree-'), 'tree')
    runGit(repo.root, 'worktree', 'add', '-q', '-b', 'side', tree)
    const { exec, asked } = counting()
    expect(await remoteAt(exec, tree)).toBe('git@github.com:acme/api.git')
    expect(await remoteAt(exec, tree)).toBe('git@github.com:acme/api.git')
    expect(asked()).toBe(1)
    runGit(repo.root, 'remote', 'set-url', 'origin', 'git@github.com:acme/moved.git')
    expect(await remoteAt(exec, tree)).toBe('git@github.com:acme/moved.git')
  })

  it('asks again after ten minutes, for a remote set somewhere the stamp cannot see', async () => {
    const repo = mkrepo()
    runGit(repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/api.git')
    const { exec, asked } = counting()
    let at = 0
    const now = () => at
    await remoteAt(exec, repo.root, { now })
    at = CREDENTIAL_KEEP_MS - 1
    await remoteAt(exec, repo.root, { now })
    expect(asked()).toBe(1)
    at = CREDENTIAL_KEEP_MS
    await remoteAt(exec, repo.root, { now })
    expect(asked()).toBe(2)
  })

  it('never keeps "no remote", which a git that did not answer in time looks the same as', async () => {
    const repo = mkrepo()
    const { exec, asked } = counting()
    expect(await remoteAt(exec, repo.root)).toBe('')
    expect(await remoteAt(exec, repo.root)).toBe('')
    expect(asked()).toBe(2)
    // And one that is not a checkout at all has nothing to stamp, so it is asked every time.
    const nowhere = tmp('tade-not-a-repo-')
    await remoteAt(exec, nowhere)
    await remoteAt(exec, nowhere)
    expect(asked()).toBe(4)
  })

  it('reads no .git that is not a regular file, which would be a read that never came back', async () => {
    const odd = tmp('tade-fifo-git-')
    execFileSync('mkfifo', [join(odd, '.git')])
    const { exec, asked } = counting()
    expect(await remoteAt(exec, odd)).toBe('')
    expect(asked()).toBe(1)
  })
})

/** Real git, counted: the stamp is the file's, so the answers have to be git's own. */
function counting(): { exec: ForgeOptions['exec']; asked: () => number } {
  let asked = 0
  return {
    exec: (command, args, options) => {
      asked++
      return forgeExec(command, args, options)
    },
    asked: () => asked,
  }
}
