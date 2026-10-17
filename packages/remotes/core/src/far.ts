import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Evaluations, TALK_THERE, writeCarried, writeSetting } from '@tade/core'
import {
  appendDevice,
  type CarryLine,
  carryingAt,
  type IntakeIn,
  type MachineAnswer,
  mintOwner,
  type Open,
  type OpenAnswer,
  type ProjectIn,
  type Projector,
  projector,
  type Reach,
  type RecordsAnswer,
  type RepositoryHere,
  reachOf,
  readDevices,
  type SignInHere,
  type SnapshotInput,
  Streams,
  type Surface,
  type Take,
  type TakeAnswer,
  Tickets,
  type ToolReadAnswer,
  type WebConnecting,
  type WebServer,
  webServer,
} from '@tade/web'
import { type FarAct, type FarAgent, farActing, farLane, farTask } from './far-agents.ts'
import { FarTalk } from './far-talk.ts'

export type { FarAct, FarAgent } from './far-agents.ts'
export type { FarSaid, FarTalk } from './far-talk.ts'

import type { OwnerSession } from './port.ts'

// The far end: another machine's Tade, as a link sees one — for the
// conformance suite, and for the window's tests of what it draws and asks of
// another machine.
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
  /**
   * The projects it has from now on, and what any of them is called there —
   * whatever somebody there wrote, as its away view sends it — and the agents
   * in them, with their screens (`far-agents.ts`); the next beat sends what
   * moved.
   */
  show(
    projects: readonly string[],
    titles?: Readonly<Record<string, string>>,
    agents?: readonly FarAgent[],
  ): void
  /** Every verb an owner asked of it, oldest first, as its window was handed each. */
  readonly acted: FarAct[]
  /** Its orchestrator's conversation, what was said to it, and the journal its catch-up reads (`far-talk.ts`). */
  readonly talk: FarTalk
  /** The newest presence any owner carried, in its clock, or null. */
  readonly presentAt: number | null
  /** How many streams are open to it. */
  readonly streams: number
  /**
   * What its journal would hold of carries: every `config_changed` and
   * `carried_in` line one wrote, oldest first — kept for its whole life, as a
   * journal is, so a carry after a restart reads what came before it. A test
   * adds a line here as somebody at that machine would have written one.
   */
  readonly lines: CarryLine[]
  /** What its harnesses say of their sign-ins, as a carry answers them. A test sets it. */
  signIns: SignInHere[]
  /**
   * Whether it takes a message from another screen, as a carry answers it
   * (`TALK_THERE`): on, as a fresh Tade has it. A test turns it off; an owner's
   * press turns it on again, through its config as a window's does.
   */
  talking: boolean
  /**
   * The line its window answers an owner asking to be shown a task's agent
   * (`/api/attach`), by task. A test sets it; a task not in it is answered as
   * one whose agent is not running there.
   */
  readonly attachable: Map<string, string>
  /**
   * Where its projects are checked out and the branches their work is on, as
   * its window answers an owner (`/api/repositories`). A test sets it; empty,
   * it has no project anybody could fetch.
   */
  repositories: RepositoryHere[]
  /**
   * The outside watches its window says it looks with, by project, as its
   * projection carries them (`ProjectRow.watching`). A test sets it; a project
   * not in it watches nothing there.
   */
  readonly watching: Map<string, readonly string[]>
  /**
   * What its window answers an owner asking what that machine is
   * (`/api/machine`): a test sets it; null, a machine with nothing to say —
   * no public name, no problem, no schedule and no document.
   */
  machine: MachineAnswer | null
  /** How many times an owner has asked what it is. */
  readonly machineAsked: number
  /**
   * What its window answers an owner asking it to look at its public name's
   * records (`/api/records`): a test sets it; null, a machine with no public name.
   */
  records: RecordsAnswer | null
  /** How many times an owner has asked it to look at its records. */
  readonly recordsAsked: number
  /**
   * What its window knows of connecting GitHub there (`/api/connect`): a test
   * sets it before anything asks; null, a window that cannot say.
   */
  connecting: WebConnecting | null
  /** Its scorecards, as its window folds them (`GET /api/evaluations`); null before it has read its journal. */
  evaluations: Evaluations | null
  /** The requests handed to it, as its projection carries them (`intake`). A test sets them. */
  intake: IntakeIn[]
  /** The documents its window reads an owner, by `<task>/<name>` (`/api/document`). A test sets them. */
  readonly documents: Map<string, { at: string; text: string }>
  /** Its extension tools that only read, by name, as its window runs them for an owner (`/api/tool`). */
  readonly tools: Map<string, (input: Record<string, unknown>) => ToolReadAnswer>
  /** Work an owner handed it (`/api/take`), oldest first, as its window was handed each, with the device. */
  readonly taken: { take: Take; device: string }[]
  /**
   * What its window answers work handed to it. A test sets it; unset, it takes
   * anything into a project it has, as `<project>/<name>`, and refuses a
   * project it has not got — in the real window's own words for that.
   */
  taking: ((take: Take) => TakeAnswer) | null
  /** Projects an owner moved here (`/api/open`), oldest first, as its window was handed each. */
  readonly opened: { open: Open; device: string }[]
  /**
   * What its window answers a project moved to it. A test sets it; unset, it
   * opens it under the name asked for and shows it among its projects.
   */
  opening: ((open: Open) => OpenAnswer) | null
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
  opts: {
    projects?: readonly string[]
    home?: string
    /**
     * Its public name, for what it answers about one (`/api/connect`). Its
     * public listener does not come up — there is no Caddy here — and says so.
     */
    publicName?: string
  } = {},
): Promise<FarEnd> {
  const home = opts.home ?? (await mkdtemp(join(tmpdir(), 'tade-far-')))
  const far = new Far(home, opts.projects ?? ['far'], opts.publicName ?? null)
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
  readonly lines: CarryLine[] = []
  signIns: SignInHere[] = []
  talking = true
  readonly attachable = new Map<string, string>()
  repositories: RepositoryHere[] = []
  readonly watching = new Map<string, readonly string[]>()
  machine: MachineAnswer | null = null
  machineAsked = 0
  records: RecordsAnswer | null = null
  recordsAsked = 0
  connecting: WebConnecting | null = null
  evaluations: Evaluations | null = null
  intake: IntakeIn[] = []
  readonly documents = new Map<string, { at: string; text: string }>()
  readonly tools = new Map<string, (input: Record<string, unknown>) => ToolReadAnswer>()
  readonly taken: { take: Take; device: string }[] = []
  taking: ((take: Take) => TakeAnswer) | null = null
  readonly opened: { open: Open; device: string }[] = []
  opening: ((open: Open) => OpenAnswer) | null = null
  readonly acted: FarAct[] = []
  readonly talk = new FarTalk()
  private agents: readonly FarAgent[] = []
  /** When the agents were last shown: their moments, fixed, so a beat finds nothing moved. */
  private shownAt = Date.now()
  private server: WebServer | null = null
  private projects: readonly string[]
  private titles: Readonly<Record<string, string>> = {}
  private readonly projectors = new Map<string, Projector>()
  private timer: NodeJS.Timeout | null = null

  readonly home: string

  private readonly publicName: string | null

  constructor(home: string, projects: readonly string[], publicName: string | null = null) {
    this.home = home
    this.projects = projects
    this.publicName = publicName
  }

  /** The connect half a test set, or a throw that says none was. */
  private connected(): WebConnecting {
    if (this.connecting === null) throw new Error('this far end was told nothing about GitHub')
    return this.connecting
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
      // Acting on: what an owner asks of an agent there is written down (`acted`);
      // talking on: what is said to its orchestrator is too (`talk`).
      surface: { ...SURFACE, port, acting: true, talking: true, publicName: this.publicName },
      // No Caddy here: a public name's socket goes nowhere it could listen, and says so.
      ...(this.publicName === null
        ? {}
        : { publicSocket: join(this.home, 'no-caddy-here', 'away.sock') }),
      connecting: {
        page: (source) => this.connected().page(source),
        form: (source, want) => this.connected().form(source, want),
        installUrl: (source, state, home, challenge) =>
          this.connected().installUrl(source, state, home, challenge),
        made: (source, code) => this.connected().made(source, code),
        installed: (source, back) => this.connected().installed(source, back),
        keep: (source, fields) => this.connected().keep(source, fields),
      },
      acting: farActing(this.acted),
      asking: this.talk.asking(),
      since: async (device, cut) => this.talk.since(device, cut, Date.now()),
      readingFor: (reach) => this.projectorFor(reach),
      tickets: new Tickets(),
      streams,
      confirm: async () => ({ let: false, why: 'refused' }),
      present: (device, at) => {
        this.presentAt = Math.max(this.presentAt ?? at, at)
        this.talk.present(device, at, Date.now())
      },
      // A carry lands the way it does on a machine with a window: the one
      // write path into its config, read back, and a line for each.
      carrying: carryingAt({
        home: this.home,
        configPath: join(this.home, 'config.yaml'),
        lines: async () => this.lines,
        write: (path, value, carry, by) =>
          writeCarried(join(this.home, 'config.yaml'), { path, value, carry, by }, async (line) => {
            this.lines.push(line)
          }),
        log: async (line) => {
          this.lines.push(line)
        },
        signIns: async () => this.signIns,
        machine: 'far',
        talk: {
          on: () => this.talking,
          turnOn: async (by) => {
            const config = join(this.home, 'config.yaml')
            await writeCarried(
              config,
              { path: TALK_THERE, value: true, carry: 'kept', by },
              (line) => {
                this.lines.push(line)
                return Promise.resolve()
              },
            )
            this.talking = true
          },
        },
      }),
      attaching: (task) => {
        const line = this.attachable.get(task)
        return line === undefined
          ? { command: null, why: 'its agent is not running there' }
          : { command: line }
      },
      repositories: async () => this.repositories,
      machine: async () => {
        this.machineAsked++
        return this.machine ?? quietMachine()
      },
      document: async ({ task, name }) => {
        const one = this.documents.get(`${task}/${name}`)
        return one === undefined ? null : { ...one, bytes: Buffer.byteLength(one.text) }
      },
      tool: async ({ tool, input }) => this.tools.get(tool)?.(input) ?? null,
      records: async () => {
        this.recordsAsked++
        return (
          this.records ?? {
            at: new Date().toISOString(),
            name: null,
            head: null,
            lines: [],
            cannot: 'it has no public name',
          }
        )
      },
      opening: async (open, device) => {
        this.opened.push({ open, device })
        if (this.opening !== null) return this.opening(open)
        if (!this.projects.includes(open.name)) this.projects = [...this.projects, open.name]
        const root = join(this.home, 'checkouts', open.name)
        return { opened: true, project: open.name, root, said: `Opened ${open.name}.` }
      },
      taking: async (take, device) => {
        this.taken.push({ take, device })
        if (this.taking !== null) return this.taking(take)
        if (!this.projects.includes(take.project)) {
          return { took: false, said: `There is no project called ${take.project} here.` }
        }
        const task = `${take.project}/${take.name}`
        return take.check
          ? { took: true, task, said: `${task} can be taken here.`, pushes: null }
          : {
              took: true,
              task,
              said: `${task} is queued and starts here as soon as there is room.`,
              pushes: take.begins ? true : null,
            }
      },
    })
    this.server = server
    const bound = await server.listen()
    const at = bound.find((address) => address.startsWith('127.0.0.1:'))
    if (at === undefined)
      throw new Error(`the far end bound nothing on loopback: ${bound.join(' ')}`)
    this.port = Number(at.slice(at.lastIndexOf(':') + 1))
    // As a machine with the away view on has it, so the real CLI pairs here —
    // written into what is there, so what a carry wrote survives a restart.
    const config = join(this.home, 'config.yaml')
    writeSetting(config, 'surfaces.web.enabled', true)
    writeSetting(config, 'surfaces.web.port', this.port)
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

  show(
    projects: readonly string[],
    titles: Readonly<Record<string, string>> = {},
    agents: readonly FarAgent[] = [],
  ): void {
    this.projects = projects
    this.titles = titles
    this.agents = agents
    this.shownAt = Date.now()
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
    const made = projector(this.inputFor(reach), Date.now(), {
      agent: (task) => {
        const one = this.agents.find((agent) => agent.task === task)
        return one === undefined ? null : farLane(one, this.shownAt)
      },
      evaluations: () => this.evaluations,
    })
    this.projectors.set(reach.device, made)
    return made
  }

  private inputFor(reach: Reach): SnapshotInput {
    return {
      lifetime: { epoch: this.epoch, rev: this.projectorRev(reach), openedAt: 0 },
      reach,
      projects: this.projects.map((name) =>
        projectIn(name, this.titles[name] ?? '', this.watching.get(name) ?? []),
      ),
      tasks: this.agents.map((agent) => farTask(agent, this.shownAt)),
      queue: [],
      findings: null,
      notes: [],
      intake: this.intake,
      sources: [],
      runs: [],
      workflows: [],
      talk: this.talk.input(),
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

function projectIn(name: string, title: string, watching: readonly string[]): ProjectIn {
  return { name, title, open: true, changes: 0, can: [], cannot: [], watching }
}

/** A machine with nothing to say about itself: what the far end answers until a test says more. */
function quietMachine(): MachineAnswer {
  const at = new Date().toISOString()
  return {
    at,
    version: '0.0.0',
    newer: null,
    public: null,
    problems: [],
    schedules: [],
    documents: [],
  }
}
