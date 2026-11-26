import { afterEach, describe, expect, it } from 'vitest'
import { DISK_BODY_MAX, DISK_MOST, type DiskAsk, type WebDisk } from '../src/disk.ts'
import { mintOwner } from '../src/owner.ts'
import { BODY_MAX, CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// What is on this machine's disk in one of its projects (`disk.ts`), for an
// owner at this machine's own door: a file with what git says of it, or the
// branches — and for nobody else, and never a field the schema did not decide on.

afterEach(closeAll)

const FILE = {
  what: 'file' as const,
  path: '/srv/tade/src/a.ts',
  relative: 'src/a.ts',
  size: 12,
  binary: false,
  truncated: false,
  text: 'export {}\n',
  error: null,
  diff: null,
}

/** A machine whose window answers every ask with that file, or its branches, and what it was asked. */
async function machine(disk?: WebDisk) {
  const asked: DiskAsk[] = []
  const one = await start(
    {},
    {
      owned: {
        disk:
          disk ??
          (async (one) => {
            asked.push(one)
            if (one.project !== 'tade') return null
            return one.what === 'branches'
              ? { what: 'branches', branches: [{ name: 'main', current: true, when: 'now' }] }
              : { ...FILE, extra: 'not decided on' }
          }),
      },
    },
  )
  return { one, asked }
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/disk', {
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

describe('what is on this machine’s disk in one of its projects, asked from another', () => {
  it('answers an owner with the file and nothing the schema did not decide on', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    const said = await asOwner(one, made, {
      project: 'tade',
      agent: 'tade/fix',
      what: 'file',
      path: 'src/a.ts',
      diff: true,
    })
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual(FILE)
    expect(asked).toEqual([
      { project: 'tade', agent: 'tade/fix', what: 'file', path: 'src/a.ts', diff: true },
    ])
  })

  it('answers an owner with the branches', async () => {
    const { one } = await machine()
    const said = await asOwner(one, await owner(one), {
      project: 'tade',
      agent: null,
      what: 'branches',
    })
    expect(JSON.parse(said.text)).toEqual({
      what: 'branches',
      branches: [{ name: 'main', current: true, when: 'now' }],
    })
  })

  it('is the 404 of a project that is not open here', async () => {
    const { one } = await machine()
    const said = await asOwner(one, await owner(one), {
      project: 'other',
      agent: null,
      what: 'branches',
    })
    expect(said.status).toBe(404)
  })

  it('refuses a phone that is not the person’s own, however much it was granted, and never asks the window', async () => {
    const { one, asked } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/disk', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ project: 'tade', agent: null, what: 'file', path: 'a' }),
    })
    expect(said.status).toBe(403)
    expect(asked).toEqual([])
  })

  it('reads its ask for its shape: a file needs a path, and a path has no NUL', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    for (const body of [
      { project: 'tade', agent: null, what: 'file' },
      { project: 'tade', agent: null, what: 'file', path: 'a\0b' },
      { project: 'tade', agent: null, what: 'file', path: '' },
      { project: 'tade', agent: null, what: 'root' },
      { project: 'tade', agent: null, what: 'branches', root: '/' },
      null,
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('never sends more of a file than its bound, whatever the window handed it', async () => {
    const { one } = await machine(async () => ({ ...FILE, text: 'x'.repeat(DISK_MOST.file + 1) }))
    const said = await asOwner(one, await owner(one), {
      project: 'tade',
      agent: null,
      what: 'file',
      path: 'a',
    })
    expect(said.status).toBe(500)
  })

  it('is the 404 of a path nobody wired where the window gave no way to answer', async () => {
    const one = await start()
    const said = await asOwner(one, await owner(one), {
      project: 'tade',
      agent: null,
      what: 'branches',
    })
    expect(said.status).toBe(404)
  })

  it('carries a whole file to save, past the body every other route is held to, and answers what the write did', async () => {
    const wrote = {
      what: 'wrote' as const,
      ok: false,
      said: 'It changed on disk since you opened it.',
    }
    const { one, asked } = await machine(async (one) => {
      asked.push(one)
      return wrote
    })
    const text = 'x'.repeat(BODY_MAX * 2)
    const save = {
      project: 'tade',
      agent: null,
      what: 'save',
      path: 'src/a.ts',
      text,
      was: { size: 12, mtimeMs: 1_700_000_000_000.5 },
    }
    const said = await asOwner(one, await owner(one), save)
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual(wrote)
    expect(asked).toEqual([save])
  })

  it('reads each write for its shape: what it expects, and a branch git would not read as an option', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    const at = { project: 'tade', agent: null }
    for (const body of [
      { ...at, what: 'save', path: 'a', text: 'x' },
      {
        ...at,
        what: 'save',
        path: 'a',
        text: 'x'.repeat(DISK_MOST.file + 1),
        was: { size: 1, mtimeMs: 1 },
      },
      { ...at, what: 'discard' },
      { ...at, what: 'switch', name: '--orphan', create: true },
      { ...at, what: 'switch', name: 'main' },
      { ...at, what: 'rename', name: 'doorbell' },
      { ...at, what: 'pull', path: '/' },
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body).slice(0, 120)).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('refuses a write from a phone that is not the person’s own, and never asks the window', async () => {
    const { one, asked } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/disk', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ project: 'tade', agent: null, what: 'pull' }),
    })
    expect(said.status).toBe(403)
    expect(asked).toEqual([])
  })

  it('refuses a body past even a save’s bound unread, and never asks the window', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    // Declared and never sent: a server that read before refusing would wait
    // here for ever, so the answer coming back is what proves "unread". Sending
    // the body as well raced the 413's close — the client's next write met a
    // closed socket, a `write EPIPE` nobody listened for (macOS runners).
    const said = await ask(one, '/api/disk', {
      method: 'POST',
      headers: {
        host: made.host,
        origin: `http://${made.host}`,
        cookie: `tade_away=${made.cookie}`,
        'content-type': 'application/json',
        'content-length': String(DISK_BODY_MAX + 1),
        [CSRF_HEADER]: made.csrf,
      },
    })
    expect(said.status).toBe(413)
    expect(asked).toEqual([])
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'disk')).toMatchObject({
      method: 'POST',
      path: '/api/disk',
      here: true,
    })
  })
})
