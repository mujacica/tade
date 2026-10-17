import { writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// Another machine's work in this machine's repository, through the whole
// window (REMOTE-TADE.md §9.3, §9.5): a branch there that would collide with
// one here, told to the orchestrator once — and nothing of it written into the
// checkout.
//
// The far end is a real away view (`far.ts`) answering where its work is with
// a real clone of this repository, and the link is the scripted one, which
// hands git that clone's path: real fetches into a real mirror.

const REPOSITORY = 'git@github.com:acme/app.git'

describe('another machine’s work, in this window', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let repo: Repo
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
    home = one.home
    repo = one.repo
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))

  /** A commit on a branch of the far clone, as an agent there makes one. */
  function workThere(there: string, branch: string, files: Record<string, string>): string {
    runGit(there, 'checkout', '-q', '-B', branch, 'main')
    for (const [path, text] of Object.entries(files)) writeFileSync(join(there, path), text)
    runGit(there, 'add', '-A')
    runGit(there, 'commit', '-q', '-m', `work on ${branch}\n\nTade-Task: tade/${branch.slice(5)}`)
    return runGit(there, 'rev-parse', 'HEAD').trim()
  }

  /** The window, linked to `vps`, whose project `tade` is a clone of this checkout with these branches. */
  async function linkedTo(
    agents: readonly FarAgent[],
    branches: Record<string, { files: Record<string, string>; live: boolean }>,
  ): Promise<{ before: string }> {
    repo.git('remote', 'add', 'origin', REPOSITORY)
    const there = join(tmp('tade-there-'), 'repo')
    runGit(repo.root, 'clone', '-q', repo.root, there)
    const heads = Object.entries(branches).map(([branch, one]) => ({
      task: `tade/${branch.slice(5)}`,
      branch,
      base: 'main',
      head: workThere(there, branch, one.files),
      live: one.live,
    }))
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, agents)
    far.repositories = [
      {
        project: 'tade',
        root: there,
        repository: 'github.com/acme/app',
        base: 'main',
        branches: heads,
      },
    ]
    const table = new Map<string, ScriptedRemote>([['vps', far]])
    const session = await far.pair('mac')
    const vps = {
      ssh: 'vps',
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    await writeFile(
      join(home, 'config.yaml'),
      [
        `projects:\n  app:\n    root: ${repo.root}`,
        'remotes:\n  vps:',
        ...Object.entries(vps).map(([key, value]) => `    ${key}: ${value}`),
        '',
      ].join('\n'),
    )
    const before = repo.git('for-each-ref')
    terminal.rows = 44
    terminal.columns = 140
    await wired.start({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } }, remotes: { vps } }),
      remoteLinks: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
    })
    await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
    return { before }
  }

  it('tells the orchestrator once that a branch here and a live branch there would collide', async () => {
    const mine = repo.addTask('mine', { project: 'app', intent: 'rate in the ledger' })
    repo.commit('mine\n\nTade-Task: app/mine', { 'README.md': '# mine\n' }, mine)
    const { before } = await linkedTo(
      [{ task: 'tade/clash', title: 'Clash', branch: 'tade/clash' }],
      { 'tade/clash': { files: { 'README.md': '# theirs\n' }, live: true } },
    )
    await until(
      'the forecast written down',
      async () =>
        (await client.events({ types: ['conflict_forecast'] })).some(
          (one) => one.detail.kind === 'elsewhere',
        ),
      30_000,
    )
    const told = (await client.events({ types: ['conflict_forecast'] })).find(
      (one) => one.detail.kind === 'elsewhere',
    )
    expect(told?.detail).toMatchObject({
      project: 'app',
      tasks: ['app/mine'],
      elsewhere: { machine: 'vps', task: 'tade/clash', branch: 'tade/clash' },
      files: ['README.md'],
    })
    await until('the agent marked down the side', () => shown('⇄'), 20_000)
    // Fetched and merged in the mirror: not a ref of the checkout's moved.
    expect(repo.git('for-each-ref')).toBe(before)
  })
})
