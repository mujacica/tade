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

// **Two projects on one machine, and one listener.** Every paired phone is
// the person's own and reads every project, so what is asked here is that the
// bytes that leave the machine carry both projects' work, out of what git
// really said — and name a project a warning is about without naming where it
// is on the machine.
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
  publicName: null,
  passkeyMs: 0,
  acting: false,
  talking: false,
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
          projectLines: new Map(),
          queued: [],
          queueFacts: { tasks: new Map(), finished: new Map(), events: [], now: NOW },
          order: [],
          notes: [],
          plans: [],
          machineUpSince: null,
          spendSince: null,
          findings: null,
          checks: null,
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
  let epoch = ''
  const server = webServer({
    home: world.home,
    surface: SURFACE,
    readingFor: (reach) => readingFor(world.world, held, () => epoch)(reach),
    tickets,
    tell: () => {},
    confirm: () => Promise.resolve({ let: true }),
  })
  epoch = server.epoch
  shut.push({ close: () => server.close() })
  const bound = await server.listen()
  const host = bound.find((one) => one.startsWith('127.0.0.1'))
  if (host === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return {
    host,
    /** A device paired, and the cookie it holds. */
    pair: async (label: string): Promise<string> => {
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

describe('two projects, as a phone reads them over the wire', () => {
  it('shows a paired phone both of them', async () => {
    const world = await twoProjects()
    const serve = await serving(world)
    const every = await serve.pair('mine')

    const answer = await get(serve.host, '/api/snapshot', every)
    const snapshot = SnapshotSchema.parse(JSON.parse(answer.text))

    expect(snapshot.projects.map((one) => one.name).sort()).toEqual(['app', 'shop'])
    expect(snapshot.tasks.map((one) => one.id).sort()).toEqual([world.app, world.shop].sort())
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
    const every = await serve.pair('mine')
    const answer = await get(serve.host, '/api/snapshot', every)
    const snapshot = SnapshotSchema.parse(JSON.parse(answer.text))

    expect(snapshot.fresh.warnings.join('\n')).toContain('app')
    expect(answer.text).not.toContain(gone)
    expect(answer.text).not.toContain(home)
    expect(answer.text).not.toContain(shop.root)
  })
})
