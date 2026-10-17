import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import {
  RepositoriesAnswerSchema,
  type RepositoryHere,
  repositoriesFor,
} from '../src/repositories.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { reachOf } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// Where this machine's projects are checked out, for another machine of the
// person's to fetch their work (`repositories.ts`): an owner's question, at
// this machine's own door, never a phone's, and nothing in it but paths,
// branch names, commit ids and what names each repository.

afterEach(closeAll)

const HEAD = 'a'.repeat(40)

const PROJECTS: RepositoryHere[] = [
  {
    project: 'tade',
    root: '/home/me/tade',
    repository: 'github.com/mujacica/tade',
    base: 'main',
    branches: [{ task: 'tade/fix', branch: 'tade/fix', base: 'main', head: HEAD, live: true }],
  },
  { project: 'other', root: '/home/me/other', repository: null, base: null, branches: [] },
]

async function machine(projects = PROJECTS) {
  let asked = 0
  const one = await start(
    {},
    {
      repositories: async () => {
        asked++
        return projects
      },
    },
  )
  return { one, asked: () => asked }
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/repositories', {
    method: 'POST',
    headers: {
      host: made.host,
      origin: `http://${made.host}`,
      cookie: `tade_away=${made.cookie}`,
      'content-type': 'application/json',
      [CSRF_HEADER]: made.csrf,
    },
    body: JSON.stringify(body),
  })
}

describe('where this machine’s projects are', () => {
  it('answers an owner every project with its root and branches, in the shape another machine reads', async () => {
    const { one } = await machine()
    const said = await asOwner(one, await owner(one), {})
    expect(said.status, said.text).toBe(200)
    const body = RepositoriesAnswerSchema.parse(JSON.parse(said.text))
    expect(body.projects).toEqual(PROJECTS)
  })

  it('refuses a phone, however much it was granted, and never asks the window', async () => {
    const { one, asked } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/repositories', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({}),
    })
    expect(said.status).toBe(403)
    expect(asked()).toBe(0)
  })

  it('takes an empty body and nothing else', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    for (const body of [{ project: 'tade' }, null, []]) {
      expect((await asOwner(one, made, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(asked()).toBe(0)
  })

  it('is the 404 of a path nobody wired where the window gave no way to answer', async () => {
    const one = await start()
    expect((await asOwner(one, await owner(one), {})).status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'repositories')).toMatchObject({
      method: 'POST',
      path: '/api/repositories',
      here: true,
    })
  })

  it('leaves out a project the device does not read, and a branch no fetch could name', () => {
    const reach = reachOf({ id: 'd', projects: ['tade'], granted: [] })
    const odd = {
      ...PROJECTS[0],
      branches: [
        ...(PROJECTS[0]?.branches ?? []),
        { task: 'tade/odd', branch: '--upload-pack=touch x', base: null, head: null, live: true },
      ],
    } as RepositoryHere
    const answer = repositoriesFor([odd, ...PROJECTS.slice(1)], reach)
    expect(answer.projects.map((one) => one.project)).toEqual(['tade'])
    expect(answer.projects[0]?.branches.map((one) => one.task)).toEqual(['tade/fix'])
  })

  it('reads another machine’s answer for its shape: a newer field is let be, a wrong one refused', () => {
    const newer = { projects: [{ ...PROJECTS[0], since: 'a newer Tade' }], more: 1 }
    expect(RepositoriesAnswerSchema.safeParse(newer).success).toBe(true)
    const wrong = { projects: [{ ...PROJECTS[0], branches: [{ task: 'x', branch: '-x' }] }] }
    expect(RepositoriesAnswerSchema.safeParse(wrong).success).toBe(false)
  })
})
