import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDevice,
  mintOwner,
  type ProjectIn,
  type Projector,
  projector,
  type Reach,
  reachOf,
  readDevices,
  type SnapshotInput,
  Streams,
  type Surface,
  Tickets,
  type WebServer,
  webServer,
} from '@tade/web'
import type { OwnerSession } from './port.ts'

// The far end: another machine's Tade, as a link sees one — for the
// conformance suite and nothing else.
//
// **A real away view, not a stand-in for one.** It is `@tade/web`'s own
// listener over a home of its own, with owners minted into that home's device
// list the way `tade web pair --owner` mints them there, and the guard, the
// host binding, the streams, the ring and the cursor all the ones a VPS runs.
// What is scripted is only what a window would have gathered — which projects
// there are — so a link is held to the real protocol and a fixture cannot be
// kinder than the remote it stands for.
//
// It writes the home's `config.yaml` as a machine with the away view on would
// have it, so the real CLI pairs against it too (the ssh suite runs `tade web
// pair --owner` over a real SSH connection into this home).

export interface FarEnd {
  /** Its home: the device list, the config. */
  readonly home: string
  /** The loopback port its listener bound. */
  readonly port: number
  /** The server lifetime it is in now: a restart is another one. */
  readonly epoch: string
  /** Make this machine an owner of it, as `tade web pair --owner` does there. */
  pair(label: string): Promise<OwnerSession>
  /** Sign a device out, as `tade web revoke` does there. */
  revoke(device: string): Promise<void>
  /** The projects it has from now on; the next beat sends what moved. */
  show(projects: readonly string[]): void
  /** The newest presence any owner carried, in its clock, or null. */
  readonly presentAt: number | null
  /** How many streams are open to it. */
  readonly streams: number
  /** Its window closed and opened again: the same home and port, another epoch. */
  restart(): Promise<void>
  /** Nothing answers on its port any more. Safe twice. */
  close(): Promise<void>
  /** Listen again after `close`, on the same port. */
  reopen(): Promise<void>
}

/** How often the far end beats: often, because a test waits on it. */
const BEAT_MS = 100

export async function startFarEnd(
  opts: { projects?: readonly string[]; home?: string } = {},
): Promise<FarEnd> {
  const home = opts.home ?? (await mkdtemp(join(tmpdir(), 'tade-far-')))
  const far = new Far(home, opts.projects ?? ['far'])
  await far.listen(0)
  return far
}

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 0,
  trustedHosts: [],
  publicName: null,
  passkeyMs: 0,
  acting: false,
  talking: false,
  drafting: false,
  configuring: false,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

class Far implements FarEnd {
  port = 0
  presentAt: number | null = null
  private server: WebServer | null = null
  private projects: readonly string[]
  private readonly projectors = new Map<string, Projector>()
  private timer: NodeJS.Timeout | null = null

  readonly home: string

  constructor(home: string, projects: readonly string[]) {
    this.home = home
    this.projects = projects
  }

  get epoch(): string {
    return this.server?.epoch ?? ''
  }

  get streams(): number {
    return this.server?.streams.count ?? 0
  }

  async listen(port: number): Promise<void> {
    this.projectors.clear()
    const streams = new Streams()
    const server = webServer({
      home: this.home,
      surface: { ...SURFACE, port },
      readingFor: (reach) => this.projectorFor(reach),
      tickets: new Tickets(),
      streams,
      confirm: async () => ({ let: false, why: 'refused' }),
      present: (_device, at) => {
        this.presentAt = Math.max(this.presentAt ?? at, at)
      },
    })
    this.server = server
    const bound = await server.listen()
    const at = bound.find((address) => address.startsWith('127.0.0.1:'))
    if (at === undefined)
      throw new Error(`the far end bound nothing on loopback: ${bound.join(' ')}`)
    this.port = Number(at.slice(at.lastIndexOf(':') + 1))
    // As a machine with the away view on has it, so the real CLI pairs here.
    await writeFile(
      join(this.home, 'config.yaml'),
      `surfaces:\n  web:\n    enabled: true\n    port: ${this.port}\n`,
    )
    this.timer = setInterval(() => void this.beat(), BEAT_MS)
    this.timer.unref()
  }

  async pair(label: string): Promise<OwnerSession> {
    const owner = await mintOwner(this.home, { port: this.port, label, from: '' }, Date.now())
    return { device: owner.device, cookie: owner.cookie, csrf: owner.csrf, host: owner.host }
  }

  async revoke(device: string): Promise<void> {
    await appendDevice(this.home, {
      kind: 'revoked',
      device,
      at: new Date().toISOString(),
      why: 'signed out',
    })
    this.server?.streams.revoke(device, 'signed out')
  }

  show(projects: readonly string[]): void {
    this.projects = projects
  }

  async restart(): Promise<void> {
    const port = this.port
    await this.close()
    await this.listen(port)
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    const server = this.server
    this.server = null
    await server?.close()
  }

  async reopen(): Promise<void> {
    if (this.server === null) await this.listen(this.port)
  }

  /** What the window's beat does (`wire/web.ts`): a projection per listening device, pushed if it moved. */
  private async beat(): Promise<void> {
    const server = this.server
    if (server === null) return
    const now = Date.now()
    const { devices } = await readDevices(this.home)
    for (const device of devices) {
      // A device signed out by the CLI is let go of on the beat, as the window does.
      if (device.revoked !== null) server.streams.revoke(device.id, 'signed out')
    }
    for (const id of server.streams.listening()) {
      const device = devices.find((one) => one.id === id)
      if (device === undefined) continue
      const reach = reachOf(device)
      const delta = this.projectorFor(reach).beat(this.inputFor(reach), now)
      if (delta !== null) server.streams.push(id, delta, now)
    }
    server.streams.beat(now)
  }

  private projectorFor(reach: Reach): Projector {
    const held = this.projectors.get(reach.device)
    if (held !== undefined) return held
    const made = projector(this.inputFor(reach), Date.now())
    this.projectors.set(reach.device, made)
    return made
  }

  private inputFor(reach: Reach): SnapshotInput {
    return {
      lifetime: { epoch: this.epoch, rev: this.projectorRev(reach), openedAt: 0 },
      reach,
      projects: this.projects.map(projectIn),
      tasks: [],
      queue: [],
      findings: null,
      notes: [],
      intake: [],
      sources: [],
      runs: [],
      workflows: [],
      talk: null,
      plans: [],
      warnings: [],
      machineUpSince: null,
      spendSince: null,
      checks: null,
    }
  }

  private projectorRev(reach: Reach): number {
    return this.projectors.get(reach.device)?.rev ?? 0
  }
}

function projectIn(name: string): ProjectIn {
  return { name, title: '', open: true, changes: 0, can: [], cannot: [] }
}
