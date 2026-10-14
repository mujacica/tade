import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SettingGroup } from '@tade/core'
import type { AgentIn } from '../src/agent.ts'
import type { Device } from '../src/devices.ts'
import type { SnapshotInput } from '../src/input.ts'
import type { Reach } from '../src/reach.ts'

// The away view, run with no browser: the page's own `boot.js`, routed to each
// screen a picture wants, over the projection of a made-up world — and what it
// built, written out as XHTML for `page-svg.ts` (in `packages/app`) to put in a
// picture.
//
// **Nothing here draws the page.** The page draws itself, through the same
// modules a phone loads, from the same answers the server would give it: the
// snapshot is `projector(...).snapshot()` handed over as the stream's first
// frame, `/api/devices` is `listing(...)`, and an agent's screen is
// `projector(...).agent(...)` — so a page that changes how it looks changes
// its pictures, and `packages/app/test/pictures.test.ts` says so in the commit
// that changed it. What stands in for the browser is `still-dom.ts`, and the
// globals the page reaches for (`still-visit.ts`).
//
// **A visit is a process of its own**, because a page load is a page of its
// own: the page keeps counters and sets in its modules — an id for each
// heading, which lists are folded — that start from nothing in a browser on
// every load, and would carry on from the last visit in a process that loaded
// the modules once. It also keeps every global the page needs out of whoever
// asked: a test worker never has its `fetch` or its clock replaced.
//
// **Fixed, so a picture is the same bytes on every machine**: the clock is the
// world's, the zone is UTC, a date the page lets the browser spell is spelt
// `en-US`, and no timer the page sets ever fires — the moment is the one after
// the snapshot and the answers it asked for, and nothing after it.

/** One browser's visit: a device, a size, a pointer, and the screens it is taken on, in order. */
export interface Visit {
  /** Which of the world's devices this is. */
  device: string
  width: number
  height: number
  pointer: 'fine' | 'coarse'
  /**
   * The docks this device keeps folded (`menu`, `side`, `tade`) — what a
   * person who pressed `[`, `]` or `\` once has, and what `docks.js` reads
   * back from its one key.
   */
  folded?: readonly string[]
  /**
   * What a browser measured at this size, by selector, for the places in the
   * page that ask how much room they have (`StillDocument.measured`).
   */
  measured?: Readonly<Record<string, number>>
  paths: readonly string[]
}

/** The made-up world a visit is drawn against. */
export interface World {
  now: number
  /** Every device that can get in, each with its name and what it was granted. */
  devices: readonly Device[]
  input: (reach: Reach) => SnapshotInput
  agent: (task: string) => AgentIn | null
  settings: () => { groups: SettingGroup[]; known: string[] }
}

/** What one screen looked like: the frame's two outer elements' classes, and its body. */
export interface Still {
  path: string
  width: number
  height: number
  pointer: 'fine' | 'coarse'
  /** The `<html>` element's classes, which the stylesheet reads as `:root`'s. */
  rootClass: string
  /** The `<body>`'s classes, and everything in it, as XHTML. */
  bodyClass: string
  body: string
  title: string
}

/**
 * Where a world is, so a fresh process can load it: a module, by URL, and the
 * name it exports the world under.
 */
export interface WorldAt {
  module: string
  name: string
}

/** The world itself, from where it is. */
export async function worldAt(at: WorldAt): Promise<World> {
  const loaded = (await import(at.module)) as Record<string, World | undefined>
  const world = loaded[at.name]
  if (world === undefined) throw new Error(`${at.module} exports no world called ${at.name}`)
  return world
}

const VISIT = fileURLToPath(new URL('./still-visit.ts', import.meta.url))

/** How long one visit may take before it is a page that hung rather than a slow one. */
const DEADLINE_MS = 60_000

/** Every screen of every visit, in the order the visits were given. */
export async function stillsOf(at: WorldAt, visits: readonly Visit[]): Promise<Still[]> {
  return (await Promise.all(visits.map((visit) => visitedApart(at, visit)))).flat()
}

/**
 * One visit, in a process of its own, and what it drew.
 *
 * Its environment is the zone and nothing else that could change a picture: no
 * locale, no `NODE_OPTIONS`, no home. A page that threw, hung or drew
 * something other than itself is a rejection carrying what it said.
 */
function visitedApart(at: WorldAt, visit: Visit): Promise<Still[]> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [VISIT, at.module, at.name, JSON.stringify(visit)], {
      env: { TZ: 'UTC', PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const where = `${visit.device} ${visit.paths.join(' ')}`
    const late = setTimeout(() => {
      child.kill('SIGKILL')
      failed(new Error(`the page did not finish drawing ${where} in ${DEADLINE_MS / 1000}s`))
    }, DEADLINE_MS)
    child.on('error', (problem) => {
      clearTimeout(late)
      failed(problem)
    })
    child.on('close', (code) => {
      clearTimeout(late)
      const said = Buffer.concat(err).toString('utf8').trim()
      if (code !== 0) {
        failed(new Error(`the page could not be drawn at ${where}:\n${said}`))
        return
      }
      try {
        done(JSON.parse(Buffer.concat(out).toString('utf8')) as Still[])
      } catch {
        failed(
          new Error(`the page at ${where} answered with something that is not stills:\n${said}`),
        )
      }
    })
  })
}
