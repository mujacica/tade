import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { Open } from '@tade/web'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { startSshd } from '../../../remotes/ssh/test/sshd.ts'
import type { Wiring } from '../../src/wire/context.ts'
import type { Lifecycle } from '../../src/wire/web-lifecycle.ts'
import { openingFrom } from '../../src/wire/web-open.ts'

// This machine's half of a project another machine moves here (`web-open.ts`):
// found among its projects, opened where a checkout of it already is, cloned
// with this machine's own credentials beside the projects it has where none
// is — over a real `sshd` — and never written over. The window's own door is
// stood in for, because what it does with a path is `projects.test.ts`'s.

const sshd = await startSshd()
afterAll(async () => {
  if (typeof sshd !== 'string') await sshd.stop()
})

const was = process.env.GIT_SSH_COMMAND
afterEach(() => {
  if (was === undefined) delete process.env.GIT_SSH_COMMAND
  else process.env.GIT_SSH_COMMAND = was
})

const ORIGIN = 'git@github.com:acme/app.git'

/** A machine whose one project, `other`, is checked out in a folder of its own. */
function machine(projects: Record<string, string> = {}) {
  const other = mkrepo()
  const place = join(tmp('tade-place-'), 'code')
  mkdirSync(place)
  const root = join(place, 'other')
  runGit(dirname(other.root), 'clone', '-q', other.root, root)
  const opened: { path: string; name: string; by: string }[] = []
  const lifecycle = {
    agents: () => ({}) as never,
    projects: () => ({
      closeProject: async () => '',
      openAt: async (req: { path: string; name: string; by: string }) => {
        opened.push({ path: req.path, name: req.name, by: req.by })
        return `Opened ${req.name}.`
      },
    }),
  } as unknown as Lifecycle
  const config = ConfigSchema.parse({
    projects: Object.fromEntries(
      Object.entries({ other: root, ...projects }).map(([name, at]) => [name, { root: at }]),
    ),
  })
  const wire = { opts: { config } } as unknown as Wiring
  const opening = openingFrom(wire, lifecycle)
  if (opening === undefined) throw new Error('no opening where the window has its doors')
  return { place, opening, opened }
}

const OPEN: Open = {
  from: 'mac',
  name: 'app',
  repository: 'github.com/acme/app',
  clone: ORIGIN,
}

describe('a project moved here, as this window opens it', () => {
  it('answers with the project it already is here, under whatever name', async () => {
    const app = mkrepo()
    app.git('remote', 'add', 'origin', ORIGIN)
    const one = machine({ tade: app.root })
    expect(await one.opening(OPEN, 'd1')).toEqual({
      opened: true,
      project: 'tade',
      root: app.root,
      said: 'github.com/acme/app is already open here, as tade.',
    })
    expect(one.opened).toEqual([])
  })

  it('opens a checkout of it already beside the others, and never one of something else', async () => {
    const one = machine()
    const there = join(one.place, 'app')
    runGit(one.place, 'init', '-q', there)
    runGit(there, 'remote', 'add', 'origin', 'git@github.com:acme/else.git')
    const refused = await one.opening(OPEN, 'd1')
    expect(refused).toMatchObject({ opened: false })
    if (!refused.opened) expect(refused.said).toContain('is not a checkout of github.com/acme/app')
    expect(one.opened).toEqual([])
    runGit(there, 'remote', 'set-url', 'origin', ORIGIN)
    expect(await one.opening(OPEN, 'd1')).toMatchObject({
      opened: true,
      project: 'app',
      root: there,
    })
    expect(one.opened).toEqual([{ path: there, name: 'app', by: 'device d1' }])
  })

  it('refuses a name it already has for another repository', async () => {
    const one = machine()
    const answer = await one.opening({ ...OPEN, name: 'other' }, 'd1')
    expect(answer).toEqual({
      opened: false,
      said: 'There is already a project called other here, and it is another repository.',
    })
  })

  it('says what its own credentials could not clone, and leaves nothing behind', async () => {
    const one = machine()
    const answer = await one.opening(
      { ...OPEN, clone: 'https://nowhere.invalid/acme/app.git' },
      'd1',
    )
    expect(answer).toMatchObject({ opened: false })
    if (!answer.opened) expect(answer.said).toContain('with its own credentials')
    expect(existsSync(join(one.place, 'app'))).toBe(false)
    expect(one.opened).toEqual([])
  })

  it.skipIf(typeof sshd === 'string')(
    `clones it over ssh with this machine's own key, beside the others, and opens it${typeof sshd === 'string' ? ` (${sshd})` : ''}`,
    async () => {
      if (typeof sshd === 'string') throw new Error(sshd)
      const source = mkrepo({ remote: true })
      process.env.GIT_SSH_COMMAND = `ssh -F ${sshd.config} -o BatchMode=yes`
      const one = machine()
      const answer = await one.opening({ ...OPEN, clone: `ssh://far${source.remote}` }, 'd1')
      expect(answer, JSON.stringify(answer)).toMatchObject({ opened: true, project: 'app' })
      const there = join(one.place, 'app')
      expect(runGit(there, 'rev-parse', 'HEAD').trim()).toBe(source.head())
      expect(one.opened).toEqual([{ path: there, name: 'app', by: 'device d1' }])
    },
    60_000,
  )

  it('is nothing at all where the window gave the away view no doors', () => {
    expect(openingFrom({ opts: { config: ConfigSchema.parse({}) } } as Wiring, undefined)).toBe(
      undefined,
    )
  })
})
