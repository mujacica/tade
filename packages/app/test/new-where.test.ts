import { describe, expect, it } from 'vitest'
import { type Machine, type Machines, NO_DETAIL } from '../src/machines.ts'
import { createdIn, placesOffered, startThere } from '../src/wire/new-where.ts'
import { shellIn } from '../src/wire/remote-terminals.ts'

// Where the `+` opens what it opens once there is a second machine: this
// machine first, so enter does what it always did, then a row per project on
// each machine, and a machine that takes nothing now off with why.

function machine(name: string, over: Partial<Machine> = {}): Machine {
  return {
    name,
    link: 'live',
    rev: 1,
    said: null,
    asOf: null,
    heard: true,
    projects: [
      {
        name: 'hello',
        title: null,
        agents: [],
        more: 0,
        watching: null,
        rev: 'p',
        can: [],
        cannot: [],
      },
      {
        name: 'tade',
        title: 'Tade itself',
        agents: [],
        more: 0,
        watching: null,
        rev: 'p',
        can: [],
        cannot: [],
      },
    ],
    spend: null,
    talk: null,
    closed: false,
    seen: [],
    detail: NO_DETAIL,
    ...over,
  }
}

const machines = (...remotes: Machine[]): Machines => ({ here: 'this Mac', remotes })

describe('where the + opens something', () => {
  it('offers this machine first, then every project on each other machine', () => {
    const rows = placesOffered(
      machines(machine('ipax')),
      { label: 'New agent on this Mac', note: 'app' },
      'New agent',
      'there:',
    )
    expect(rows.map((one) => one.id)).toEqual(['here', 'there:ipax hello', 'there:ipax tade'])
    expect(rows[0]).toMatchObject({ label: 'New agent on this Mac', note: 'app' })
    expect(rows[0]?.off).toBeUndefined()
    // What a project there is called there is what its row says.
    expect(rows[2]).toMatchObject({ label: 'New agent on ipax', note: 'Tade itself' })
    expect(rows[1]?.divider).toBe(true)
    expect(rows[2]?.divider).toBe(false)
  })

  it('lists a machine that is down, or has nothing open, greyed with why', () => {
    const rows = placesOffered(
      machines(
        machine('vps', { link: 'down', said: 'ssh: connect to host vps: Connection refused' }),
        machine('lab', { link: 'down' }),
        machine('box', { projects: [] }),
        machine('new', { projects: [], heard: false, link: 'linking' }),
      ),
      { label: 'here' },
      'Terminal',
      'shell:',
    )
    expect(rows.slice(1).map((one) => [one.label, one.off])).toEqual([
      ['Terminal on vps', 'ssh: connect to host vps: Connection refused'],
      ['Terminal on lab', 'lab is not linked right now'],
      ['Terminal on box', 'no project is open there'],
      ['Terminal on new', 'new is not linked right now'],
    ])
  })
})

describe('an agent started on another machine', () => {
  it('is a task there named for its words, and its agent told them', async () => {
    const asked: { method: string; params: Record<string, unknown> }[] = []
    const task = await startThere(
      async (_machine, method, params) => {
        asked.push({ method, params })
        return method === 'task/create'
          ? JSON.stringify({ id: 'hello/fix-the-bell', worktree: '/srv/hello/fix-the-bell' })
          : 'started'
      },
      'ipax',
      'hello',
      'fix the bell',
    )
    expect(task).toBe('hello/fix-the-bell')
    expect(asked).toEqual([
      {
        method: 'task/create',
        params: { project: 'hello', slug: 'fix-the-bell', intent: 'fix the bell' },
      },
      {
        method: 'worker/start',
        params: {
          task: 'hello/fix-the-bell',
          cwd: '/srv/hello/fix-the-bell',
          prompt: 'fix the bell',
        },
      },
    ])
  })

  it('takes the next name where one was used there before, and says any other refusal', async () => {
    const slugs: unknown[] = []
    await startThere(
      async (_machine, method, params) => {
        if (method !== 'task/create') return 'started'
        slugs.push(params.slug)
        if (params.slug === 'bell') throw new Error('ipax: task hello/bell already exists')
        return JSON.stringify({ id: `hello/${String(params.slug)}`, worktree: '/w' })
      },
      'ipax',
      'hello',
      'bell',
    )
    expect(slugs).toEqual(['bell', 'bell-2'])
    await expect(
      startThere(
        async () => {
          throw new Error('ipax: no project hello')
        },
        'ipax',
        'hello',
        'bell',
      ),
    ).rejects.toThrow('no project hello')
    await expect(startThere(async () => 'made it', 'ipax', 'hello', 'bell')).rejects.toThrow(
      'did not say where it works',
    )
  })

  it('reads the task a create answered, and nothing that is not one', () => {
    expect(createdIn('{"id":"a/b","worktree":"/w"}')).toEqual({ id: 'a/b', worktree: '/w' })
    expect(createdIn('{"id":"a/b"}')).toBeNull()
    expect(createdIn('task created')).toBeNull()
  })
})

describe('a terminal in a project on another machine', () => {
  const repositories = (projects: unknown[]) => ({ status: 200, body: { projects } })
  const repo = (project: string, root: string) => ({
    project,
    root,
    repository: 'github.com/acme/hello',
    base: 'main',
    branches: [],
  })

  it('is a login shell in that project’s checkout there', () => {
    expect(shellIn(repositories([repo('hello', '/srv/hello')]), 'ipax', 'hello')).toEqual({
      // The remote shell's own expansion, written in two halves so it is not read as a template.
      command: `cd /srv/hello && exec "$${'{'}SHELL:-/bin/sh}" -l`,
      why: null,
    })
  })

  it('says why not where that machine did not say where it is, or named a folder no shell is handed', () => {
    expect(shellIn(repositories([]), 'ipax', 'hello').why).toBe('hello is not open on ipax')
    expect(shellIn({ status: 404, body: null }, 'ipax', 'hello').why).toMatch(/update it there/)
    expect(shellIn({ status: 200, body: { nope: 1 } }, 'ipax', 'hello').why).toMatch(
      /did not say where/,
    )
    for (const root of ['/srv/x; rm -rf ~', '/srv/$(id)', 'relative', '/srv/../etc']) {
      expect(shellIn(repositories([repo('hello', root)]), 'ipax', 'hello').command).toBeNull()
    }
  })
})
