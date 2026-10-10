import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { collectStatus } from '@tade/status'
import {
  type Projector,
  projector,
  type Reach,
  SnapshotSchema,
  type Surface,
  Tickets,
  type WebReading,
  webServer,
} from '@tade/web'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { awayCollections, nothingKnown } from '../src/away.ts'

// **Two projects on one machine, two phones, and one listener.**
//
// `away.test.ts` asks what the projection does with a read scope, over a
// hand-written `Workspace`; `away-real.test.ts` asks what it does with a real
// `collectStatus`, with no listener. Neither asks the question an owner with
// more than one repository actually has: *does the phone I gave somebody see
// only the project I scoped it to, over the wire, out of what git really
// said?*
//
// It is a different question from the unit one in three ways, and each is a
// seam no single-project fixture can reach:
//
// 1. **A per-device projection is built per device** (`readingFor(reach)`).
//    Two devices with two scopes have to be two projectors, and filtering one
//    projection afterwards is how a field that should have been withheld rides
//    along. Two projects are what make that visible: with one, a scope that
//    was ignored looks exactly like a scope that was honoured.
// 2. **The project a task is in is read off the task**, and a task id carries
//    its project in its first half. A scope applied to the project list and
//    not to the work would leave one project's task ids on a phone scoped to
//    the other.
// 3. **Over the wire**, so what is asserted is the bytes that left the
//    machine rather than a value the test assembled.
//
// Real repositories and a real `collectStatus`, for the house reason: a
// fixture must not be kinder than reality, and nothing here mocks git.

const NOW = Date.parse('2026-10-10T14:30:00.000Z')

const shut: { close: () => Promise<unknown> }[] = []

afterEach(async () => {
  for (const one of shut.splice(0)) await one.close().catch(() => {})
})

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 0,
  trustedHosts: [],
  acting: false,
  talking: false,
  drafting: false,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

/** The home's own `config.yaml`, naming each project's root. */
function configFor(roots: Record<string, string>): string {
  const lines = ['projects:']
  for (const [name, root] of Object.entries(roots)) lines.push(`  ${name}:`, `    root: ${root}`)
  return `${lines.join('\n')}\n`
}

/** One `GET`, with everything the guard asks of a read on it. */
function get(
  host: string,
  path: string,
  cookie: string,
): Promise<{ status: number; text: string }> {
  const [address, port] = host.split(':')
  return new Promise((done, failed) => {
    const req = request(
      {
        host: address,
        port: Number(port),
        path,
        method: 'GET',
        headers: { host, cookie, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', failed)
    req.end()
  })
}

/** What a machine with two projects and a task in each looks like. */
async function twoProjects() {
  const shop = mkrepo()
  const app = mkrepo()
  const home = tmp('tade-away-projects-')
  // The home's own config, written before the workbench opens it: a project is
  // where `createTask` reads a root from, so a home with none is a workbench
  // that cannot make the work this test is about.
  writeFileSync(join(home, 'config.yaml'), configFor({ shop: shop.root, app: app.root }))
  const client = await Workbench.open({ home })
  shut.push(client)
  const first = await client.createTask({
    project: 'shop',
    slug: 'checkout',
    intent: 'the basket forgets a coupon',
  })
  const second = await client.createTask({
    project: 'app',
    slug: 'migration',
    intent: 'the migration keeps failing',
  })
  const config = ConfigSchema.parse({
    projects: { shop: { root: shop.root }, app: { root: app.root } },
  })
  const world = await collectStatus({
    config,
    now: NOW,
    home,
    tadeHome: home,
    pr: false,
    processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
  })
  return { home, client, world, shop: first.id, app: second.id }
}

/**
 * The projection, with this device's reach — one projector per device, which
 * is the rule the window is built on and the thing this file is testing.
 */
function readingFor(
  world: Awaited<ReturnType<typeof twoProjects>>['world'],
  held: Map<string, Projector>,
  epoch: () => string,
) {
  return (reach: Reach): WebReading => {
    const already = held.get(reach.device)
    if (already !== undefined) return already
    const made = projector(
      {
        ...awayCollections({
          world,
          titles: {},
          extras: new Map(
            world.projects.flatMap((one) => one.tasks.map((task) => [task.id, nothingKnown()])),
          ),
          pending: new Map(),
          intake: [],
          sources: [],
          runs: [],
          workflows: [],
          queued: [],
          queueFacts: { tasks: new Map(), finished: new Map(), events: [], now: NOW },
          order: [],
          notes: [],
          plans: [],
          machineUpSince: null,
          spendSince: null,
        }),
        reach,
        talk: null,
        lifetime: { epoch: epoch(), rev: 0, openedAt: NOW },
      },
      NOW,
    )
    held.set(reach.device, made)
    return made
  }
}

/** A listener over that world, and a device paired with the scope it is given. */
async function serving(world: Awaited<ReturnType<typeof twoProjects>>) {
  const tickets = new Tickets()
  const held = new Map<string, Projector>()
  /** Every reach the listener handed over, in the order it did. */
  const reaches: Reach[] = []
  let epoch = ''
  let scope: { projects: readonly string[] | null } = { projects: null }
  const server = webServer({
    home: world.home,
    surface: SURFACE,
    readingFor: (reach) => {
      reaches.push(reach)
      return readingFor(world.world, held, () => epoch)(reach)
    },
    tickets,
    tell: () => {},
    confirm: () => Promise.resolve({ let: true, projects: scope.projects, granted: ['titles'] }),
  })
  epoch = server.epoch
  shut.push({ close: () => server.close() })
  const bound = await server.listen()
  const host = bound.find((one) => one.startsWith('127.0.0.1'))
  if (host === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return {
    host,
    reaches: (): readonly Reach[] => reaches,
    /** A device paired with that project scope, and the cookie it holds. */
    pair: async (projects: readonly string[] | null, label: string): Promise<string> => {
      scope = { projects }
      const ticket = tickets.mint(`http://${host}/pair`, Date.now())
      const body = JSON.stringify({ ticket: ticket.value, label })
      const answer = await new Promise<{ status: number; cookie: string }>((done, failed) => {
        const [address, port] = host.split(':')
        const req = request(
          {
            host: address,
            port: Number(port),
            path: '/api/pair',
            method: 'POST',
            headers: {
              host,
              origin: `http://${host}`,
              'content-type': 'application/json',
              'sec-fetch-site': 'same-origin',
              'content-length': String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            res.resume()
            res.on('end', () =>
              done({
                status: res.statusCode ?? 0,
                cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '',
              }),
            )
          },
        )
        req.on('error', failed)
        req.write(body)
        req.end()
      })
      if (answer.status !== 201) throw new Error(`pairing answered ${answer.status}`)
      return answer.cookie
    },
  }
}

describe('two projects, as two phones read them over the wire', () => {
  it('shows a phone scoped to one project that project’s work and no other’s', async () => {
    const world = await twoProjects()
    const serve = await serving(world)
    const only = await serve.pair(['shop'], 'the one I lent out')

    const answer = await get(serve.host, '/api/snapshot', only)
    expect(answer.status).toBe(200)
    const snapshot = SnapshotSchema.parse(JSON.parse(answer.text))

    expect(snapshot.projects.map((one) => one.name)).toEqual(['shop'])
    expect(snapshot.tasks.map((one) => one.id)).toEqual([world.shop])

    // Asked of the whole payload rather than of the fields somebody
    // remembered: a field added next month that carried the other project's
    // work would fail here.
    expect(answer.text).not.toContain(world.app)
    expect(answer.text).not.toContain('app/')
  })

  it('shows a phone scoped to every project both of them', async () => {
    const world = await twoProjects()
    const serve = await serving(world)
    const every = await serve.pair(null, 'mine')

    const answer = await get(serve.host, '/api/snapshot', every)
    const snapshot = SnapshotSchema.parse(JSON.parse(answer.text))

    // The other half, so the test above cannot pass by showing one project to
    // everybody: with no scope, both are there.
    expect(snapshot.projects.map((one) => one.name).sort()).toEqual(['app', 'shop'])
    expect(snapshot.tasks.map((one) => one.id).sort()).toEqual([world.app, world.shop].sort())
  })

  it('hands the listener each device’s own reach, never the one that asked first', async () => {
    const world = await twoProjects()
    const serve = await serving(world)
    // **The narrow one first**, which is the order that catches a reach being
    // reused: a listener that remembered the first device's would serve a wide
    // phone one project while its own record says it reads every.
    const only = await serve.pair(['shop'], 'the one I lent out')
    const every = await serve.pair(null, 'mine')

    const narrow = SnapshotSchema.parse(
      JSON.parse((await get(serve.host, '/api/snapshot', only)).text),
    )
    const wide = SnapshotSchema.parse(
      JSON.parse((await get(serve.host, '/api/snapshot', every)).text),
    )
    expect(narrow.projects.map((one) => one.name)).toEqual(['shop'])
    expect(wide.projects.map((one) => one.name).sort()).toEqual(['app', 'shop'])

    // And what the listener actually asked for, which is the half an
    // assertion about the bytes cannot separate from the projection's own
    // doing: one reach per device, each read out of that device's own record.
    const asked = serve.reaches()
    expect(asked.length).toBeGreaterThanOrEqual(2)
    const byDevice = new Map(asked.map((one) => [one.device, one]))
    expect(byDevice.size).toBe(2)
    const scopes = [...byDevice.values()].map((one) => one.projects)
    expect(scopes).toContainEqual({ kind: 'every' })
    expect(scopes).toContainEqual({ kind: 'listed', names: ['shop'] })

    // Asking again under the first cookie is still the first device's scope.
    const again = SnapshotSchema.parse(
      JSON.parse((await get(serve.host, '/api/snapshot', only)).text),
    )
    expect(again.projects.map((one) => one.name)).toEqual(['shop'])
  })

  it('names the project a warning is about without naming where it is on the machine', async () => {
    // Two projects and one of them not a checkout, which is what a moved or
    // deleted repository looks like. The phone has to be able to tell which
    // one, and must not be told where either of them is.
    const shop = mkrepo()
    const gone = tmp('tade-away-gone-')
    const home = tmp('tade-away-projects-')
    writeFileSync(join(home, 'config.yaml'), configFor({ shop: shop.root, app: gone }))
    const client = await Workbench.open({ home })
    shut.push(client)
    const config = ConfigSchema.parse({
      projects: { shop: { root: shop.root }, app: { root: gone } },
    })
    const world = await collectStatus({
      config,
      now: NOW,
      home,
      tadeHome: home,
      pr: false,
      processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    })
    expect(world.warnings.join('\n')).toContain(gone)

    const serve = await serving({ home, client, world, shop: '', app: '' })
    const every = await serve.pair(null, 'mine')
    const answer = await get(serve.host, '/api/snapshot', every)
    const snapshot = SnapshotSchema.parse(JSON.parse(answer.text))

    expect(snapshot.fresh.warnings.join('\n')).toContain('app')
    expect(answer.text).not.toContain(gone)
    expect(answer.text).not.toContain(home)
    expect(answer.text).not.toContain(shop.root)
  })
})
