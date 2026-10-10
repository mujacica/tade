import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  type Arm,
  type Config,
  ConfigSchema,
  type GitSnapshot,
  LOCAL,
  type Queued,
  type TadeEvent,
  type Task,
  taskDir,
  type Workspace,
  writeSetting,
} from '@tade/core'
import {
  allowDevice,
  digestOf,
  type Reach,
  type Snapshot,
  type TaskRow,
  type WebReading,
  writeDevices,
} from '@tade/web'
import { Workbench } from '@tade/workbench'
import { parse } from 'yaml'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { ActionsView } from '../../src/frame.ts'
import type { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { awayPanel } from '../../src/panels/away/state.ts'
import { emptyTranscript, type Transcript } from '../../src/transcript.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Away } from '../../src/wire/web.ts'
import { type FactoryHeld, nothingHandedOver } from '../../src/wire/web-beat.ts'
import { homeConfig, INTAKE } from './away-intake.ts'

// A window with a real workbench behind it, a real listener on loopback, and a
// phone making real requests.
//
// **Everything here is real but the browser.** A real git repository, a real
// workbench writing real task files, a real `node:http` listener, and requests
// made with `node:http` because `fetch` cannot set `Host`. What that buys is
// the thing a fake cannot say: that the value a phone echoes back (`was`) is
// the value the projection put on the row, that it is compared against what
// the workbench actually wrote, and that the journal says a device did it.
//
// The one thing that is a stand-in is `Live`. The window's held state needs
// `git`, `ps` and a driver to build, and none of that is what an act is about
// — so what is faked is exactly the set of accessors `Away` reads (`Held`),
// with the task's **real** park read back off its **real** file every time.
// That is what keeps `seen()` honest: the facts a verb is checked against come
// from the same place the row's revision did.
//
// **Where it answers nothing, nothing is the honest answer and not a kindness.**
// `seenActions` is null, which is `unknown` and is what a task nobody has
// looked at really reads; `spendToday` is empty, which is *nothing recorded*;
// `git` is null on every task, which is what a tree nobody has scanned says.
// Each of those is the direction that cannot make a test pass by accident —
// a fixture that said `pass`, `$0.00` or `ready` would. The two things a test
// has to be able to make true are real when it asks for them: `running` puts
// an agent in the world *and* answers for its harness through `offer()`, and
// `queued` puts a real `Queued` in front of the queue's own `queueStateOf`
// rather than asserting a word onto the row.

export const SECRET = 'A'.repeat(43)
export const DEVICE = '00112233445566aa'
export const COOKIE = `tade_away=${DEVICE}.${SECRET}`
export const KEY = 'abcdefgh12345678'

const open: Away[] = []
const shut: Workbench[] = []

/** Everything this harness opened, closed. Called from one `afterEach`. */
export async function closeAll(): Promise<void> {
  for (const one of open) await one.stop()
  open.length = 0
  for (const one of shut) await one.close().catch(() => {})
  shut.length = 0
}

/** A port the machine has just said is free, so nothing is guessed. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/** What a test holds: the window, the workbench, and the levers it needs. */
export interface Machine {
  away: Away
  home: string
  client: Workbench
  task: string
  port: number
  news: string[]
  /** Add a task to the faked world, so the projection has a row for it. */
  watch(task: string): void
  /** An agent is running on this task, as the world and the harness say. */
  running(task: string, harness?: string): void
  /**
   * This task is queued work, with nothing in front of it.
   *
   * **A real `Queued` and a real `QueueFacts`**, because the queue's own rule
   * is what decides the word on the row and a stand-in that just said `ready`
   * would make every queue test pass against a fixture rather than against
   * `queueStateOf`.
   */
  queued(task: string): void
  /**
   * What the last look at this task's checks said: red, or nothing at all.
   *
   * Nothing at all is the default and is the honest one — a task nobody has
   * looked at reads `unknown`, and the away view may not start a look to find
   * out.
   */
  checked(task: string, rollup: 'pass' | 'fail'): void
  /** An approval is waiting on this task, by that id. */
  waiting(task: string, requestId: string, tool?: string): void
  /**
   * This task's branch is out for review, as a forge answered.
   *
   * A real `GitSnapshot`, because what the row carries is read off one: a
   * fixture that asserted the state onto the row would pass while the
   * projection read a different field.
   */
  reviewed(task: string, state: 'draft' | 'open' | 'merged' | 'closed', url?: string): void
  /** That approval is not waiting any more, as a harness would stop holding it. */
  answered(requestId: string): void
  /** Take the intake grant out of the window's config, leaving the home's. */
  ungrant(): void
  /** What was decided, in the order it was decided. */
  decided: { run: string; requestId: string; allow: boolean; reason?: string }[]
  /** What was said to an agent, in the order it was said. */
  told: { task: string; said: string }[]
  /** Re-read the journal into the faked `Live`, and drop the memoised beat. */
  refresh(): Promise<void>
  /** Open the panel, which is what `panel()` draws only when it is open. */
  show(): void
  /** What a device said to Tade, in the order it was said. */
  said: { text: string; device: string }[]
  /** The arms every remote turn was handed, so a test can read what it narrowed to. */
  armed: Arm[]
}

export interface MachineOptions {
  acting?: boolean
  /** Why work from outside may not go ahead, where a test wants it held. */
  stands?: () => Promise<string | null>
  /** The factory floor, where a test wants requests, doors, runs or workflows in it. */
  factory?: () => FactoryHeld
  /** The config the window reads, where a test needs a grant in it. */
  config?: (over: { root: string; port: number }) => Config
  /** What `steerAgent` does, where a test wants it to fail. */
  steering?: (task: string, said: string) => Promise<void>
  /** A harness with no way to take a message mid-turn, as `offer()` reads one. */
  cannotSteer?: boolean
  /**
   * Intake on, with one grant, in **both** configs.
   *
   * Both because the two are read at different moments and for different
   * questions: the home file is what the workbench reads when a delivery
   * arrives (`takeIntake`), and the window's own is what a grant is re-read
   * from at the moment of approving. A fixture that wrote only one would pass
   * a test about the grant for the wrong reason.
   */
  intake?: boolean
  /** Talking to Tade on, as `surfaces.web.orchestrator` turns it on. */
  talking?: boolean
  /** The conversation the window holds, where a test needs lines in it. */
  transcript?: Transcript
  /** Whether a turn is in flight, and whose. */
  busy?: boolean
  whose?: string
  /** What `askRemote` does, where a test wants it to fail or to record the arm. */
  ask?: (said: string, arm: Arm) => Promise<void>
  /** What stopping the turn answers: false for a harness that cannot. */
  stop?: () => Promise<boolean>
  /**
   * What writing the generated notification key does, where a test watches it.
   *
   * Unset, it writes into this harness's own `config.yaml` — see the default
   * below for why a stub that answered without writing would be a fixture
   * kinder than reality.
   */
  writeKey?: (key: string, value: string, was: string) => Promise<void>
}

export async function machine(over: MachineOptions = {}): Promise<Machine> {
  const repo = mkrepo()
  const home = tmp('tade-away-act-')
  writeFileSync(join(home, 'config.yaml'), homeConfig(repo.root, over.intake === true))
  const client = await Workbench.open({ home })
  shut.push(client)
  const first = await client.createTask({
    project: 'app',
    slug: 'migration',
    intent: 'the migration keeps failing',
  })

  let state: AppState = initialState()
  const news: string[] = []
  const port = await freePort()
  const config =
    over.config?.({ root: repo.root, port }) ??
    ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      surfaces: {
        web: {
          enabled: true,
          port,
          acting: over.acting ?? true,
          orchestrator: over.talking === true,
        },
        ...(over.intake === true ? { intake: INTAKE } : {}),
      },
    })
  const watched: string[] = [first.id]
  const agents = new Map<string, string>()
  const pending: { run: string; task: string; requestId: string; tool: string; at: number }[] = []
  const queued: Queued[] = []
  const looked = new Map<string, ActionsView>()
  /**
   * The git snapshot per task, where a test asked for one.
   *
   * **Null is still the default**, which is what a tree nobody has scanned
   * says: a fixture that handed every task a clean snapshot would make a
   * review state and a branch appear on work nobody has pushed.
   */
  const reviews = new Map<string, GitSnapshot>()
  const decided: Machine['decided'] = []
  const told: Machine['told'] = []
  let events: TadeEvent[] = []

  const live = {
    get events() {
      return events
    },
    get pending() {
      return pending
    },
    get world(): Workspace {
      return worldOf(home, repo.root, watched, agents, reviews)
    },
    seenActions: (task: string) => looked.get(task) ?? null,
    spendToday: () => ({ byTask: {} }),
    get queued() {
      return queued
    },
    queueFacts: () => ({
      tasks: new Map(),
      finished: new Map(),
      events,
      now: Date.now(),
    }),
    notes: () => [],
    plans: [],
    titles: {},
    tasks: [],
    machineUpSince: null,
    spendSince: null,
    talk: null,
    worktreeOf: () => repo.root,
  }

  let held = config
  const wire = {
    opts: {
      home,
      get config() {
        return held
      },
      client: new Proxy(client, {
        get(target, name) {
          // The three doors a verb reaches that a real harness would answer,
          // stood in for here: what is running, what is waiting, and what
          // happens when something is said to an agent. Everything else —
          // the task files, the journal, the notes, the queue — is the real
          // workbench's.
          if (name === 'runs') {
            return () => [...agents].map(([task, harness]) => ({ task, harness, run: task }))
          }
          if (name === 'capabilitiesOf') {
            return () => capabilities(over.cannotSteer === true ? 'none' : 'live')
          }
          if (name === 'pendingApprovals') {
            return (task?: string) => pending.filter((one) => !task || one.task === task)
          }
          if (name === 'decideApproval') {
            return (run: string, requestId: string, how: { allow: boolean; reason?: string }) => {
              const at = pending.findIndex((one) => one.requestId === requestId)
              if (at >= 0) pending.splice(at, 1)
              decided.push({ run, requestId, ...how })
              return Promise.resolve()
            }
          }
          if (name === 'steerAgent') {
            return async (task: string, said: string) => {
              if (over.steering) await over.steering(task, said)
              told.push({ task, said })
            }
          }
          return Reflect.get(target, name) as unknown
        },
      }),
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    get live() {
      return live as unknown as Live
    },
    now: () => Date.now(),
    openedAt: 0,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring

  const said: { text: string; device: string }[] = []
  const armed: Arm[] = []
  const away = new Away(wire, {
    decided: () => {},
    news: (one) => news.push(one),
    talk: {
      arm: () =>
        over.busy === true ? { how: 'remote', device: DEVICE, projects: null, may: [] } : LOCAL,
      busy: () => over.busy === true,
      whose: () => over.whose ?? '',
      askRemote: async (text: string, arm: Arm) => {
        armed.push(arm)
        await over.ask?.(text, arm)
      },
      stopTurn: over.stop ?? (() => Promise.resolve(true)),
      remoteSaid: (text: string, device: string) => said.push({ text, device }),
    },
    stands: over.stands ?? (() => Promise.resolve(null)),
    factory: over.factory ?? (() => nothingHandedOver()),
    saved: () => {},
    // A fixture must not be kinder than reality: a key written here goes into
    // the harness's own config file, so a test that turns notifications on
    // reads a key back the way the window does.
    // **A fixture must not be kinder than reality**, and a stub that answered
    // *written* without writing is the kindest shape there is: the one key
    // that goes through this door is generated, so a test whose key silently
    // vanished would be a window minting a new one on every beat and nothing
    // saying so. The default writes it into this harness's own `config.yaml`
    // through the one writer a setting goes through — and deliberately does
    // **not** hand it to the window, which is the direction that makes a test
    // depending on it fail rather than pass.
    writeKey:
      over.writeKey ??
      ((key, value) => {
        writeSetting(join(home, 'config.yaml'), key, value)
        return Promise.resolve()
      }),
  })
  open.push(away)
  const made: Machine = {
    away,
    home,
    client,
    task: first.id,
    port,
    news,
    said,
    armed,
    decided,
    told,
    watch: (task) => void watched.push(task),
    running: (task, harness = 'pi') => void agents.set(task, harness),
    checked: (task, rollup) =>
      void looked.set(task, {
        task,
        branch: null,
        base: null,
        ahead: null,
        behind: null,
        dirty: 0,
        shared: true,
        commit: 'abc1234',
        mine: [],
        others: [],
        review: null,
        checks: [
          {
            id: 'tests',
            required: true,
            state: rollup === 'fail' ? 'failed' : 'passed',
          },
        ],
        rollup,
        source: 'its commit hook',
        unread: [],
        running: null,
        notes: [],
      } as unknown as ActionsView),
    queued: (task) =>
      void queued.push({
        task,
        project: 'app',
        parked: false,
        start: { after: [], prompt: 'do the thing', touches: [] },
      } as unknown as Queued),
    waiting: (task, requestId, tool = 'Bash') =>
      void pending.push({ run: task, task, requestId, tool, at: Date.now() }),
    answered: (requestId) => {
      const at = pending.findIndex((one) => one.requestId === requestId)
      if (at >= 0) pending.splice(at, 1)
    },
    reviewed: (task, state, url = `https://forge.invalid/app/pull/${state}`) => {
      reviews.set(task, {
        branch: `tade/${task.split('/')[1] ?? task}`,
        head: 'a'.repeat(40),
        headSubject: 'the fix',
        headTime: Date.now(),
        dirty: [],
        ahead: 2,
        behind: 0,
        baseRef: 'main',
        mergedIntoBase: state === 'merged',
        upstreamGone: false,
        pr: { state, url },
      })
    },
    ungrant: () => {
      held = ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: {
          web: {
            enabled: true,
            port,
            acting: over.acting ?? true,
            orchestrator: over.talking === true,
          },
        },
      })
    },
    refresh: async () => {
      events = await client.events({})
      away.beat()
    },
    show: () => {
      state = { ...state, panel: awayPanel() }
    },
  }
  return made
}

/** Intake on, accepting `cli` requests from `kim` into `app`. */
/**
 * A capabilities answer that can take a message live. The one `offer()` reads.
 *
 * Only `why` and `steer` matter here; the rest is filled in so the shape is a
 * real `WorkerCapabilities` rather than a cast.
 */
function capabilities(steer: 'live' | 'idle' | 'none' = 'live') {
  return {
    permissionGate: true,
    steer,
    queue: 'live' as const,
    abort: 'live' as const,
    model: 'live' as const,
    thinking: 'live' as const,
    thinkingLevels: [],
    rename: 'live' as const,
    images: 'inline' as const,
    visibleUi: false,
    resume: true,
    resumeKeeps: true,
    continues: true,
    done: true,
    nativeExtensions: false,
    skills: false,
    tools: true,
    mcp: true,
    headless: true,
    spend: { usd: 'exact' as const, tokens: true, limits: 'none' as const },
    accounts: false,
    why: steer === 'none' ? { steer: 'pi has no way to take a message mid-turn' } : {},
  }
}

/** The capabilities of a harness that cannot be told anything. */
export const CANNOT_STEER = capabilities('none')

/**
 * The world, with each task's **real** park read back off its **real** file.
 *
 * Read every time rather than captured, which is what makes "somebody parked
 * it at the keyboard since" a thing a test can do with the workbench and have
 * the projection see.
 */
function worldOf(
  home: string,
  root: string,
  tasks: readonly string[],
  agents: ReadonlyMap<string, string>,
  git: ReadonlyMap<string, GitSnapshot> = new Map(),
): Workspace {
  return {
    generatedAt: new Date().toISOString(),
    projects: [
      {
        name: 'app',
        root,
        brief: null,
        untracked: [],
        tasks: tasks.map((id) => taskOf(home, root, id, agents.has(id), git.get(id) ?? null)),
      },
    ],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  }
}

function taskOf(
  home: string,
  root: string,
  id: string,
  running: boolean,
  git: GitSnapshot | null = null,
): Task {
  // **Read out of the real task file, including the two the runs fold needs.**
  // `effort` and `start` are what group tasks into a run and what the graph's
  // edges are, and a fixture that ignored them would make every run of one
  // task with no waits — which is the one shape the fold cannot get wrong.
  const file = parse(readFileSync(join(taskDir(home, id), 'task.yaml'), 'utf8')) as {
    parked?: boolean
    by?: string
    done?: Task['done']
    effort?: string
    start?: Task['start']
  }
  return {
    id,
    project: 'app',
    branch: `tade/${id.split('/')[1] ?? id}`,
    worktree: root,
    created: new Date().toISOString(),
    state: file.parked === true ? 'parked' : 'queued',
    reason: 'no agent has started',
    stalled: false,
    ...(file.effort === undefined ? {} : { effort: file.effort }),
    ...(file.start === undefined ? {} : { start: file.start }),
    git,
    agents: running
      ? [
          {
            provider: 'pi',
            session: 'one',
            cwd: root,
            lastActivityAt: Date.now(),
            messages: 1,
            pid: null,
          },
        ]
      : [],
    lanes: [],
    ...(file.parked === undefined ? {} : { parked: file.parked }),
    ...(file.by === undefined ? {} : { by: file.by }),
    ...(file.done === undefined ? {} : { done: file.done }),
  } as unknown as Task
}

/** Whether a task's own file says it is parked. */
export function parkedIn(home: string, task: string): boolean {
  const file = parse(readFileSync(join(taskDir(home, task), 'task.yaml'), 'utf8')) as {
    parked?: boolean
  }
  return file.parked === true
}

/** What `context.md` holds for a task, or the empty string for none. */
export function contextIn(home: string, task: string): string {
  try {
    return readFileSync(join(taskDir(home, task), 'context.md'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * The row the projection put on one task, as the page would read it.
 *
 * Through the window's own `readingFor`, with this device's reach, so what a
 * test echoes back as `was` is literally the value a phone would have had —
 * never a revision the test built itself, which would make every act pass
 * against a rule nobody checked.
 */
export function rowOf(one: Machine, task: string): TaskRow {
  const made = (
    one.away as unknown as { readingFor: (reach: Reach) => WebReading }
  ).readingFor.call(one.away, { device: DEVICE, projects: { kind: 'every' }, granted: [] })
  const row = made.snapshot().tasks.find((each) => each.id === task)
  if (row === undefined) throw new Error(`no row for ${task}`)
  return row
}

/**
 * The whole projection, as a device with those grants would read it.
 *
 * Through `readingFor` for `rowOf`'s reason: what a test reads is literally
 * what a phone would have been sent, built by the one function that decides
 * what leaves the machine — never a shape the test assembled, which would make
 * every assertion about the fixture.
 */
export function projectionOf(
  one: Machine,
  granted: readonly string[] = [],
  /**
   * The device this reading is for.
   *
   * **A different id per reach, and the default is only right once per test.**
   * The window keeps one projector per device (`projectorFor`) — which is
   * correct, because a read scope is per device and the projection is built
   * per device — so two reads under one id get the projection built for
   * whichever reach asked first. A test comparing a granted read with an
   * ungranted one has to ask as two devices, which is what a person with two
   * phones actually has.
   */
  device = DEVICE,
): Snapshot {
  const made = (
    one.away as unknown as { readingFor: (reach: Reach) => WebReading }
  ).readingFor.call(one.away, {
    device,
    projects: { kind: 'every' },
    granted: granted as Reach['granted'],
  })
  return made.snapshot()
}

/** A second device id, for the read that is compared with the first. */
export const OTHER = '00112233445566bb'

/** Just its revision, which is what every verb echoes back. */
export function revOf(one: Machine, task: string): string {
  return rowOf(one, task).rev
}

/** One act, as a browser would send it. */
export function act(
  port: number,
  verb: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return send(port, `/api/act/${verb}`, body)
}

/** One `POST` with everything the guard asks of a mutation on it. */
function send(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body)
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'x-tade-csrf': 'x'.repeat(43),
          'sec-fetch-site': 'same-origin',
          'content-length': String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const said = Buffer.concat(chunks).toString('utf8')
          done({
            status: res.statusCode ?? 0,
            body: said === '' ? {} : (JSON.parse(said) as Record<string, unknown>),
          })
        })
      },
    )
    req.on('error', failed)
    req.write(text)
    req.end()
  })
}

/**
 * One message to Tade, as a browser would send it.
 *
 * A sibling of `act` and not a parameter on it, because the two paths are two
 * tables with two settings behind them: a test that reached the asking route
 * by passing `'ask'` as a verb would be a test that passes while they are one
 * route.
 */
export function ask(
  port: number,
  what: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return send(port, `/api/ask/${what}`, body)
}

/** A device in the file, already granted whatever the test needs. */
export async function paired(
  home: string,
  port: number,
  scopes: readonly string[],
  /**
   * What this device was granted at the machine.
   *
   * On the `paired` line and not through `allowDevice`, because that is where
   * the record keeps them: widening what a device may *do* and widening what
   * it may *read* are two acts, and only the first has a door of its own.
   */
  granted: readonly string[] = [],
): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: DEVICE,
      at: new Date().toISOString(),
      label: 'iPhone',
      digest: digestOf(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: ['read'],
      projects: null,
      granted: granted as never,
      from: '127.0.0.1',
    },
  ])
  if (scopes.length > 0) await allowDevice(home, DEVICE, scopes, new Date())
}

/** One save of a draft field, as a browser would send it. */
export function save(
  port: number,
  what: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return send(port, `/api/draft/${what}`, body)
}

/**
 * Wait for one journal line, because the audit is written **beside** the
 * answer and not before it.
 *
 * A reporter that blocked a response would mean a phone waiting on a disk, and
 * the rule everywhere else in Tade is that a reporter never throws or blocks.
 * So the line lands a tick later, and a test that read the journal the
 * microsecond the answer arrived would be a test about scheduling.
 */
export async function waitFor(client: Workbench, type: string): Promise<Record<string, unknown>[]> {
  for (let tries = 0; tries < 50; tries++) {
    const found = await client.events({ types: [type as 'web_did'] })
    if (found.length > 0) return found as unknown as Record<string, unknown>[]
    await new Promise((done) => setTimeout(done, 10))
  }
  return []
}
