import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountAway, AccountsAnswer, AccountsCall } from '../src/accounts.ts'
import { Moved, NotOffered, type Outcome, type WebActing } from '../src/acting.ts'
import { type ActivityIn, AGENT, MOMENTS } from '../src/agent.ts'
import type { MenuItemIn } from '../src/agent-menu.ts'
import type { ChatIn, TalkIn } from '../src/input.ts'
import type { MachinesAnswer } from '../src/machines.ts'
import type { Reach } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import { webServer } from '../src/server.ts'
import { OFF } from '../src/surface.ts'
import { Tickets } from '../src/tickets.ts'
import {
  allUnrun,
  axeRefused,
  CUT_ALLOWED,
  exitFor,
  type Finding,
  LOOKS,
  NOT_FOR_A_GRANTED_DEVICE,
  READY,
  said,
  sayReport,
  WIDTHS,
  worstOf,
} from '../test/browser-plan.ts'
import { agentHeld, input, NOW, note, queued, settingRows, task } from '../test/fixtures.ts'
import { accountsAt } from './browser-accounts.ts'
import { chatAt, harnessTalk } from './browser-chat.ts'
import { deskAt, lanesSeen, paletteAt, paletteTappedAt, unpairedAt } from './browser-desk.ts'
import { doingAt, type Running } from './browser-doing.ts'
import { frameAt } from './browser-frame.ts'
import { machinesAt } from './browser-machines.ts'
import { momentsAt } from './browser-moments.ts'
import { asPwa } from './browser-pwa.ts'
import { queueAt } from './browser-queue.ts'
import {
  AXE,
  CONTROLS,
  CUT,
  HOLD,
  HOLD_AGAIN,
  RECEIVED,
  SAID_MOVED,
  SAID_SOMETHING,
  SHAPE,
  STATUS,
} from './browser-snippets.ts'
import { until } from './browser-until.ts'
import { WHOLE_NOTE, wholeAt } from './browser-whole.ts'

// The away view, in a real browser, against the real server and the real files.
//
//   node packages/web/scripts/browser.ts                  # report to stdout
//   node packages/web/scripts/browser.ts --shots <dir>    # and write the pictures
//
// **It needs a browser, and it says `unrun` when there is none.** Playwright
// and `axe-core` are not in this repository's lockfile and are not meant to be:
// Playwright's install pulls a few hundred megabytes of browser onto every
// contributor's machine and into every CI job, and this repository holds the
// line that `pnpm install` runs two scripts and installs nothing else. So they
// are **optional, on the machine**:
//
//   pnpm add -D -w playwright@1.64.1 axe-core@4.14.0 && pnpm exec playwright install chromium
//
// **Those exact versions** (`AXE_CORE`, `PLAYWRIGHT_AT` in `browser-plan.ts`):
// with nothing in a lockfile, the install decides the verdict, so under any
// other axe-core the script refuses to run and says why.
//
// or, with a Chrome the machine already has and no download at all:
//
//   TADE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
//     node packages/web/scripts/browser.ts
//
// With them, this answers the questions only a browser owns — does axe find
// anything, does the page scroll sideways at 360px, is every control big enough
// to hit, does pairing work when a person actually presses the button. Without
// them every one of those is reported `unrun` **with the reason**, and the last
// line says so: a missing browser must never read as a passing suite.
//
// **The snippets that run in the page are strings**, deliberately, and they are
// `browser-snippets.ts`. They execute in a browser, where `document` exists and
// this repository's `lib` has no DOM; written as closures they would be code
// `tsc` has to pretend to understand. As strings they are what they are — a
// payload handed over the debugger protocol — and in their own file this one
// stays the thing that drives a browser rather than a file half made of
// another language.
//
// What it is pointed at is the projection's own fixtures, so no real work is on
// screen and no picture of it can carry one. It binds loopback on port 0 and
// closes the listener however it ends.
//
// **Its home and its pictures are not in the temp folder.** A `tade-` name
// there is one the suite's own guard answers for (`test/own-tmp.ts`), so a run
// of this beside a full suite turned it red; both go in `node_modules/.cache`,
// and the home is removed when the run ends, however it ends.

/** Where a run's home and its pictures are made: beside the dependencies, and never committed. */
const SCRATCH = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url))

const shots = shotsDir(process.argv)
const findings: Finding[] = []

/** The real listener, the real pairing, and a ticket to walk in with. */
async function serve() {
  await mkdir(SCRATCH, { recursive: true })
  const home = await mkdtemp(join(SCRATCH, 'tade-away-browser-'))
  const tickets = new Tickets()
  const held = new Map<string, ReturnType<typeof projector>>()
  const server = webServer({
    home,
    // **Acting on**: the route table is built with the listener, so turning it
    // on later is not a thing a harness can do. Every paired device may act,
    // and the third pass drives a real tap, a real Tab and a real refusal.
    // **`OFF` and then what this harness turns on**, so a capability added to
    // the surface arrives here off rather than as a guess.
    surface: {
      ...OFF,
      enabled: true,
      port: 0,
      acting: true,
      talking: true,
      // On, or there is no registration to ask anything of; what is precached
      // is the page, which carries nobody's work.
      installing: true,
      keepsView: true,
    },
    acting: recording,
    // **Talking on too, with the same stub treatment**: the third pass sends
    // a real message with a real tap. `stop` answers `not_offered`, for the reason `note` answers
    // `gone`: a harness where everything succeeds can never show that a
    // refusal leaves what somebody typed where it was.
    asking: {
      unlocked: () => true,
      ask: (call) => {
        asked.push({ verb: 'ask', task: '', said: call.said })
        return Promise.resolve({ did: true, rev: call.was, said: 'Tade is answering' })
      },
      stop: () => Promise.reject(new NotOffered('this harness cannot stop a turn')),
    },
    readingFor: (reach: Reach) => {
      reaches.set(reach.device, reach)
      const mine = held.get(reach.device)
      if (mine !== undefined) return mine
      const made = projector(
        input({ reach, talk: harnessTalk(), notes: NOTES, tasks: TASKS }),
        NOW,
        {
          agent: () =>
            agentHeld({
              activity: LIFE.slice(0, AGENT.activity),
              earlier: LIFE[AGENT.activity - 1]?.id ?? null,
            }),
          settings: () => ({ groups: settingRows(), known: [] }),
        },
      )
      held.set(reach.device, made)
      return made
    },
    // **An agent's record further back than its page holds**, so its page
    // reads back to its first turn as Tade's conversation does; Tade's own
    // reads back through what the projection holds, which is all of it here.
    earlier: {
      talk: async () => true,
      agent: async () => ({
        turns: [
          { kind: 'sent', text: 'Start with the projection.', images: [], at: NOW - 600_000 },
        ],
        before: null,
      }),
      // **Its moments before the newest stretch**, a page at a time down to
      // its making, so its timeline reads on to its first moment.
      moments: async (_task, before) => {
        const page = LIFE.filter((one) => Number(one.id) < Number(before)).slice(0, MOMENTS)
        const first = page.length < MOMENTS || page.at(-1)?.kind === 'made'
        return { activity: page, earlier: first ? null : (page.at(-1)?.id ?? null) }
      },
      known: () => [],
      places: () => ({ work: null, tade: null, home: null }),
    },
    // **The Machines page's half**, as the window hands it over
    // (`machinesFrom`): the grid as it stands and a press that starts and never
    // waits — so the page is drawn from an answer rather than the `404` of a
    // route nobody wired.
    // **One agent's menu, as the window builds it**: queued work's own
    // (`queueMenuItems`, mapped by `awayMenuOf`), so the side's ⋯ on a piece
    // opens what the window's right-click does; the route cuts it per device.
    menus: {
      menu: (id) => Promise.resolve(id === QUEUED.id ? { items: QUEUE_MENU } : null),
    },
    machines: {
      shown: () => MACHINES,
      press: () => true,
      settle: () => false,
    },
    // **The Accounts page's half**, as the window hands it over
    // (`AccountsHere`): this machine's accounts, or a linked machine's, by the
    // tab a look names — a press answered with the page as it stands.
    accounts: {
      carry: async (call: AccountsCall) => accountsFor(call.machine ?? null),
      signIn: async () => ({
        state: 'idle',
        who: null,
        how: null,
        rows: [],
        link: null,
        said: null,
        about: null,
      }),
    },
    tickets,
    tell: () => {},
    // The keypress at the machine, answered yes — which is the whole of what
    // authorises a pairing, and the one thing a browser cannot press.
    confirm: async () => ({ let: true }),
  })
  const bound = await server.listen()
  const at = bound.find((one) => one.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return { server, origin: `http://${at}`, tickets, held, home }
}

/** What was asked of the window, in the order it was asked. */
const asked: { verb: string; task: string; said: string }[] = []

/**
 * A window that does each verb and remembers being asked — and refuses one.
 *
 * **`note` always answers `gone`**, deliberately: the thing a browser is the
 * only place to check is that a refusal leaves what somebody typed in the box,
 * and a verb that always succeeds can never show it. The others answer, so a
 * tap and a keypress have something to prove.
 */
const recording: WebActing = {
  unlocked: () => true,
  park: (call) => did('park', call),
  answer: (call) => did('answer', call),
  steer: (call) => did('steer', call),
  queue: (call) => did('queue', call),
  done: (call) => did('done', call),
  note: (call) => {
    asked.push({ verb: 'note', task: call.task, said: (call as { text: string }).text })
    return Promise.reject(new Moved('somebody wrote one here first', call.was))
  },
  context: (call) => did('context', call),
  intake: (call) => did('intake', call),
  stop: (call) => did('stop', call),
  reopen: (call) => did('reopen', call),
  close: (call) => did('close', { task: call.project, was: call.was }),
  open: (call) => did('open', { task: call.project, was: call.was }),
  start: (call) => did('start', call),
  remove: (call) => did('remove', call),
  rename: (call) => did('rename', call),
  model: (call) => did('model', call),
  thinking: (call) => did('thinking', call),
  account: (call) => did('account', call),
  harness: (call) => did('harness', call),
  move: (call) => did('move', call),
}

function did(verb: string, call: { task: string; was: string }): Promise<Outcome> {
  asked.push({ verb, task: call.task, said: '' })
  return Promise.resolve({ did: true, rev: call.was, said: `${verb}: done` })
}

/**
 * Playwright, if this machine has it, and the reason if it does not.
 *
 * The specifier is a variable so this file type-checks on a machine that has
 * never installed it — which is every machine in CI, and is the state the
 * `unrun` report exists for.
 */
/**
 * The agent's whole life as moments, newest first, down to its making: far
 * more than one answer carries, so its timeline has to read on to reach it.
 */
/**
 * **A note of over ten thousand characters** beside the fixture's own, with no
 * summary so its card is its words: `whole` reads it back in full
 * (`browser-whole.ts`). Every beat the harness makes carries it.
 */
const NOTES = [...input().notes, note({ text: WHOLE_NOTE, summary: '', scope: null })]

/**
 * **The fixture's queued piece, with its task's row**, as the window's
 * projection carries every queued task among the tasks: a press on the
 * piece echoes that row's revision, so without it the side has nothing to
 * press. Queued, no agent, and the queue its one control.
 */
const QUEUED = task({
  id: queued().task,
  state: 'queued',
  reason: { kind: 'clause', said: 'waits on sentry/away-projection' },
  title: 'Serve the away view behind pairing',
  agents: 0,
  lanes: 0,
  lane: 'none',
  starts: 0,
  effort: '',
  review: null,
  can: [
    { verb: 'queue', how: 'now' },
    { verb: 'park', how: 'now' },
    { verb: 'done', how: 'now' },
    { verb: 'note', how: 'now' },
    { verb: 'context', how: 'now' },
  ],
  cannot: [
    { verb: 'answer', why: 'nothing is waiting on an answer' },
    { verb: 'steer', why: 'no agent is running' },
    { verb: 'intake', why: 'it did not come from outside this machine' },
    { verb: 'stop', why: 'no agent is running' },
    { verb: 'reopen', why: 'it is queued work: the queue starts it' },
  ],
})

/** Every task the harness's projection carries: the fixture's, and the queued one's row. */
const TASKS = [...input().tasks, QUEUED]

/** Queued work's menu as the window maps it (`awayMenuOf(queueMenuItems(…))`) for waiting work. */
const QUEUE_MENU: MenuItemIn[] = [
  ['open', 'Open', { kind: 'page', does: 'open' }],
  ['queue-start', 'Start now', { kind: 'verb', verb: 'queue', with: { change: 'start' } }],
  ['queue-first', 'Do this one first', { kind: 'verb', verb: 'queue', with: { change: 'first' } }],
  ['queue-pause', 'Pause', { kind: 'verb', verb: 'queue', with: { change: 'pause' } }],
  ['queue-wait', 'Wait for a retry', { kind: 'verb', verb: 'queue', with: { change: 'wait' } }],
  ['queue-after', 'Wait on…', { kind: 'here' }],
  ['queue-retell', 'Retell…', { kind: 'here' }],
  ['rename', 'Rename…', { kind: 'type', verb: 'rename', value: 'away-auth-server' }],
  ['queue-remove', 'Remove', { kind: 'verb', verb: 'remove' }],
].map(([id, label, act]) => ({
  id: id as string,
  label: label as string,
  off:
    id === 'queue-wait'
      ? 'not held'
      : id === 'queue-after'
        ? 'what it waits on is changed at the machine'
        : id === 'queue-retell'
          ? 'what it is told is changed at the machine'
          : null,
  note: null,
  danger: id === 'queue-remove',
  divider: id === 'queue-remove',
  act: act as MenuItemIn['act'],
}))

/**
 * What the Machines page is answered: this machine and one linked one, a
 * sign-in and a key each — a mark of every kind but one, and a key a shell
 * file sets, so the grid is drawn with something in every cell.
 */
const MACHINES: MachinesAnswer = {
  columns: [
    { machine: 'mac', asOf: null, here: true, said: null },
    { machine: 'vps', asOf: new Date(NOW - 600_000).toISOString(), here: false, said: null },
  ],
  rows: [
    {
      id: 'sign-in:claude',
      kind: 'sign-in',
      label: 'Claude Code',
      cells: [
        { mark: '✓', days: 21, where: [], said: null },
        { mark: '?', days: null, where: [], said: null },
      ],
    },
    {
      id: 'secret:linear',
      kind: 'secret',
      label: 'Linear key',
      cells: [
        { mark: '✓', days: null, where: ['~/.zshenv:14'], said: 'only a shell sets it' },
        { mark: '✗', days: null, where: [], said: null },
      ],
    },
  ],
  looking: false,
  plan: null,
  busy: false,
  said: null,
  file: '~/.config/tade/env',
  agents: 'any agent on this machine can read a key written down',
  notes: [],
}

/** One account the Accounts page is answered, signed in, with a plan and two windows. */
const ACCOUNT: AccountAway = {
  harness: 'claude-code',
  title: 'Claude Code',
  name: null,
  ownName: null,
  kind: 'subscription',
  canAdd: true,
  why: null,
  signedIn: true,
  who: 'person@example.com',
  plan: 'Max 20x',
  problem: null,
  windows: [
    { label: '5h', minutes: 300, used: 42 },
    { label: '7d', minutes: 10_080, used: 9 },
  ],
  agents: 3,
  forNewAgents: true,
  projects: [],
  canSignIn: true,
  install: null,
}

/**
 * What the Accounts page is answered, by tab: this machine with its own
 * sign-in, an account beside it and pi; and a linked one with an account not
 * signed in that one project runs as — a press of every kind on the page.
 */
const ACCOUNTS: Record<string, readonly AccountAway[]> = {
  here: [
    ACCOUNT,
    { ...ACCOUNT, name: 'work', forNewAgents: false, agents: 0, plan: 'Team', windows: [] },
    {
      ...ACCOUNT,
      harness: 'pi',
      title: 'pi',
      canAdd: false,
      why: 'keeps one account',
      windows: [],
    },
  ],
  vps: [
    { ...ACCOUNT, agents: 1 },
    {
      ...ACCOUNT,
      name: 'deploy-bot',
      signedIn: false,
      who: null,
      plan: null,
      windows: [],
      agents: 0,
      forNewAgents: false,
      projects: ['shop', 'sentry'],
    },
  ],
}

function accountsFor(machine: string | null): AccountsAnswer {
  return {
    machine,
    machines: [
      { id: null, label: 'mac' },
      { id: 'vps', label: 'vps' },
    ],
    accounts: [...(ACCOUNTS[machine ?? 'here'] ?? [])],
    said: null,
    trouble: false,
    keys: 'An agent runs as you, whichever sign-in it is on.',
  }
}

const LIFE: ActivityIn[] = Array.from({ length: 240 }, (_, n) => {
  const id = 240 - n
  const at = NOW - (n + 1) * 60_000
  if (id === 1) return { id: '1', at, kind: 'made', what: '', ok: null }
  const kind = (['used', 'turn', 'checked'] as const)[id % 3] ?? 'used'
  const what = kind === 'used' ? 'Edit' : kind === 'checked' ? 'tests' : ''
  return { id: String(id), at, kind, what, ok: kind === 'used' ? null : true }
})

const PLAYWRIGHT = 'playwright'

async function browser(): Promise<{ made: Engine | null; why: string }> {
  let loaded: { chromium: { launch: (opts: object) => Promise<Engine> } }
  try {
    loaded = await import(PLAYWRIGHT)
  } catch {
    return { made: null, why: 'playwright is not installed on this machine' }
  }
  // A machine may have a Chrome already and no appetite for another download:
  // `TADE_BROWSER=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  // is the way to say so, and it is why this is worth a line of code — the
  // alternative is a harness nobody can run without fetching 150MB first.
  const here = process.env.TADE_BROWSER
  const opts = { headless: true, ...(here === undefined ? {} : { executablePath: here }) }
  try {
    return { made: await loaded.chromium.launch(opts), why: '' }
  } catch (problem) {
    // Installed as a package with no browser binary behind it, which is the
    // ordinary state after an install without the download.
    return { made: null, why: `a browser could not be started: ${said(problem)}` }
  }
}

/**
 * `axe-core`'s own source, to run inside the page, or the reason there is none
 * — and the version it says it is, which `axeRefused` holds to `AXE_CORE`.
 */
async function axeSource(): Promise<{ source: string | null; why: string; version: string }> {
  let where: string
  try {
    where = import.meta.resolve('axe-core')
  } catch {
    return { source: null, why: 'axe-core is not installed on this machine', version: '' }
  }
  const own = JSON.parse(await readFile(new URL('package.json', where), 'utf8')) as {
    version?: unknown
  }
  return {
    source: await readFile(new URL(where), 'utf8'),
    why: '',
    version: typeof own.version === 'string' ? own.version : 'of no stated version',
  }
}

function found(check: string, where: string, verdict: Finding['verdict'], what: string) {
  findings.push({ check, where, verdict, said: what })
}

interface Engine {
  newContext: (opts: object) => Promise<Context>
  close: () => Promise<void>
}

interface Context {
  newPage: () => Promise<Page>
  /** Off, for the cold load in `browser-pwa.ts`. */
  setOffline: (offline: boolean) => Promise<void>
  close: () => Promise<void>
}

/** Playwright's own event hook, typed to the two events this listens for. */
interface Listen {
  (event: 'pageerror', hear: (problem: unknown) => void): void
  (event: 'console', hear: (line: { type: () => string; text: () => string }) => void): void
}

interface Page {
  on: Listen
  waitForFunction: (body: string, opts?: object) => Promise<unknown>
  goto: (url: string, opts?: object) => Promise<unknown>
  reload: (opts?: object) => Promise<unknown>
  fill: (selector: string, value: string) => Promise<void>
  click: (selector: string) => Promise<void>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  waitForURL: (url: string, opts?: object) => Promise<unknown>
  /** The snippet is a string: it runs in the browser, not in this program. */
  evaluate: (body: string) => Promise<unknown>
  addScriptTag: (opts: { content: string }) => Promise<unknown>
  title: () => Promise<string>
  screenshot: (opts: object) => Promise<unknown>
  /** One element, by what it is and what it says. The acting pass taps these. */
  locator: (selector: string, opts?: { hasText?: string }) => Thing
  keyboard: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void> }
  /**
   * The conversation is scrolled up the way a person does it, the wheel over
   * it, and a call in it opened with a tap where a thumb would be.
   */
  mouse: {
    click: (x: number, y: number) => Promise<void>
    move: (x: number, y: number) => Promise<void>
    wheel: (dx: number, dy: number) => Promise<void>
  }
  waitForTimeout: (ms: number) => Promise<void>
  /** The granted pass looks again at the phone's width on the device it already paired. */
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  emulateMedia: (opts: { reducedMotion: 'reduce' | 'no-preference' }) => Promise<void>
}

/** The four things the acting pass asks of one element, and nothing else. */
interface Thing {
  first: () => Thing
  nth: (at: number) => Thing
  tap: () => Promise<void>
  focus: () => Promise<void>
  fill: (value: string) => Promise<void>
  inputValue: () => Promise<string>
}

async function run(axe: Awaited<ReturnType<typeof axeSource>>) {
  const { made, why } = await browser()
  if (made === null) {
    findings.push(...allUnrun(why))
    return
  }
  const { server, origin, tickets, held, home } = await serve()
  if (axe.source === null) found('axe', '—', 'unrun', axe.why)
  try {
    for (const width of WIDTHS) {
      const context = await made.newContext({
        viewport: { width: width.width, height: width.height },
        // The phone's own reduced-motion setting, because a page that only
        // works with its transitions is one nobody can read on a train.
        reducedMotion: width.narrow === true ? 'reduce' : 'no-preference',
      })
      const page = await context.newPage()
      // **Anything the page throws or logs as an error is a failure.** There is
      // no build step and no typechecker over the browser's modules, so an
      // identifier nothing binds is a runtime `ReferenceError` that kills the
      // rest of an update and leaves a page that *looks* rendered — half of it
      // from the first paint, and nothing after. Without this the harness
      // walks past it: the landmarks are there, the title is right, axe is
      // happy, and the page has been dead since the first frame arrived.
      const noise: string[] = []
      page.on('pageerror', (problem) => noise.push(`threw: ${said(problem)}`))
      page.on('console', (line) => {
        if (line.type() === 'error') noise.push(`logged: ${line.text().split('\n')[0] ?? ''}`)
      })
      await unpairedAt(page, origin, width, found)
      await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, width.name)
      for (const look of LOOKS) {
        if (look.path === '/pair') continue
        const before = noise.length
        await lookAt(page, origin, look, width, axe.source)
        const fresh = noise.slice(before)
        if (fresh.length > 0) {
          found('quiet', `${look.name} @ ${width.name}`, 'fail', fresh.slice(0, 2).join('; '))
        } else {
          found('quiet', `${look.name} @ ${width.name}`, 'pass', 'nothing thrown, nothing logged')
        }
      }
      await deskAt(page, origin, width, found)
      await frameAt(page, origin, width, found)
      await paletteAt(page, origin, width, found)
      await deltaUnder(page, origin, server, held, width.name)
      await context.close()
    }
    await asGranted(made, origin, tickets, axe.source, server, held)
    await asActing(made, origin, tickets, server, held)
  } finally {
    try {
      await made.close()
      await server.close()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
}

/**
 * Every screen again, at the widest width and then at the phone's, on one
 * device resized, with the same questions asked of it.
 *
 * **The phone is the device the person actually holds**, and a page with real
 * figures in it is the one most likely to be wider than 360px or to draw a
 * control too small to hit — a dash fits anywhere. The desk is kept because it
 * has the most on screen. The tablet is left out: the two ends are where it
 * overflows.
 *
 * **One device, resized**, rather than a pairing per width: the harness pairs
 * exactly five times, which is the server's limit per address in ten minutes,
 * so a sixth would be refused. The phone look takes reduced motion, as the
 * first pass's phone does.
 */
async function asGranted(
  made: Engine,
  origin: string,
  tickets: Tickets,
  axe: string | null,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
) {
  const desk = [...WIDTHS].sort((a, b) => b.width - a.width)[0]
  const phone = WIDTHS.find((one) => one.narrow === true)
  if (desk === undefined) return
  const context = await made.newContext({
    viewport: { width: desk.width, height: desk.height },
  })
  const page = await context.newPage()
  const noise: string[] = []
  page.on('pageerror', (problem: unknown) => noise.push(`threw: ${said(problem)}`))
  page.on('console', (line: { type: () => string; text: () => string }) => {
    if (line.type() === 'error') noise.push(`logged: ${line.text().split('\n')[0] ?? ''}`)
  })
  const at = `${desk.name} granted`
  await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, at)
  const lookAll = async (at: string) => {
    for (const look of LOOKS) {
      if (look.path === '/pair') continue
      const before = noise.length
      await lookAt(page, origin, look, { name: at }, axe)
      const fresh = noise.slice(before)
      if (fresh.length > 0) {
        found('quiet', `${look.name} @ ${at}`, 'fail', fresh.slice(0, 2).join('; '))
      } else {
        found('quiet', `${look.name} @ ${at}`, 'pass', 'nothing thrown, nothing logged')
      }
    }
  }
  await lookAll(at)
  await lanesSeen(page, origin, axe, shots, found)
  await momentsAt(page, origin, at, found, LIFE.length, AGENT.activity)
  await wholeAt(page, origin, at, found)
  await chatAt(page, origin, at, arrival(page, server, held), found, heldLines)
  await doingAt(page, origin, at, busyWith(page, server, held), arrival(page, server, held), found)
  if (phone !== undefined && phone !== desk) {
    await page.setViewportSize({ width: phone.width, height: phone.height })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await lookAll(`${phone.name} granted`)
    await momentsAt(page, origin, `${phone.name} granted`, found, LIFE.length, AGENT.activity)
    await wholeAt(page, origin, `${phone.name} granted`, found)
    await chatAt(
      page,
      origin,
      `${phone.name} granted`,
      arrival(page, server, held),
      found,
      heldLines,
    )
    await doingAt(
      page,
      origin,
      `${phone.name} granted`,
      busyWith(page, server, held),
      arrival(page, server, held),
      found,
    )
  }
  await context.close()
}

/**
 * The controls, for a paired device: every one may act.
 *
 * **The three things only a browser can answer**, and each is a real failure
 * somebody would otherwise find on a phone:
 *
 * - `controls` — that what the row says may be asked of it is what is drawn,
 *   and that a verb it says cannot be is **absent with its reason beside it**
 *   rather than a dead button or a hole.
 * - `touch` — that a real tap on a real target does it. A `click()` in a test
 *   runner proves a listener is bound; a pointer event at coordinates proves
 *   the thing is reachable with a thumb.
 * - `typing` — that a refusal leaves what somebody typed where it was. The
 *   `note` verb here always answers `gone`, so this is the one check that
 *   exercises the path, and it is the one failure a person cannot undo.
 */
async function asActing(
  made: Engine,
  origin: string,
  tickets: Tickets,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
) {
  const width = [...WIDTHS].find((one) => one.narrow === true) ?? WIDTHS[0]
  if (width === undefined) return
  const context = await made.newContext({
    viewport: { width: width.width, height: width.height },
    hasTouch: true,
  })
  const page = await context.newPage()
  const at = `${width.name} acting`
  await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, at)
  const device = await deviceIn(page)
  if (device === null) {
    found('controls', at, 'unrun', 'the page never said which device this is')
    await context.close()
    return
  }
  try {
    await page.goto(`${origin}/t/sentry/away-projection`, { waitUntil: READY })
    await page.waitForSelector('main textarea', { timeout: 10_000 })
    const shape = (await page.evaluate(CONTROLS)) as {
      drawn: string[]
      reasons: string[]
      small: string[]
      blank: string[]
    }
    // Against the fixture's own two lists, so this is the page and the
    // projection held equal rather than the page against a literal.
    const wanted = ['park', 'steer', 'done', 'note', 'context']
    const missing = wanted.filter((verb) => !shape.drawn.includes(verb))
    const extra = shape.drawn.filter((verb) => !wanted.includes(verb))
    if (missing.length > 0 || extra.length > 0) {
      found(
        'controls',
        at,
        'fail',
        `drew ${shape.drawn.join(', ') || 'nothing'}; wanted ${wanted.join(', ')}`,
      )
    } else if (shape.reasons.length < 3) {
      found('controls', at, 'fail', `only ${shape.reasons.length} of 3 reasons are drawn`)
    } else if (shape.small.length > 0) {
      found('controls', at, 'fail', `too small to hit: ${shape.small.slice(0, 3).join('; ')}`)
    } else if (shape.blank.length > 0) {
      found('controls', at, 'fail', `showing an empty reason: ${shape.blank.join('; ')}`)
    } else {
      found(
        'controls',
        at,
        'pass',
        `${shape.drawn.length} drawn, ${shape.reasons.length} explained`,
      )
    }

    // A real tap, on the one control that takes no typing.
    const before = asked.length
    const press = page.locator('button', { hasText: 'Set this aside' }).first()
    await press.tap()
    await until(page, SAID_SOMETHING)
    const tapped = asked.slice(before)
    if (tapped.length === 1 && tapped[0]?.verb === 'park') {
      found('touch', at, 'pass', 'a tap on a 44px target asked for one park')
    } else {
      found('touch', at, 'fail', `a tap asked for ${tapped.map((one) => one.verb).join(', ')}`)
    }

    // The keyboard, on the same control: focused by Tab order and pressed with
    // Enter, which is what a `<button>` owes and a `<div>` with a listener
    // does not.
    const was = asked.length
    await press.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    const keyed = asked.slice(was)
    if (keyed.length === 1 && keyed[0]?.verb === 'park') {
      found('touch', `${at} keyboard`, 'pass', 'Enter on the focused control asked for one park')
    } else {
      found('touch', `${at} keyboard`, 'fail', `Enter asked for ${keyed.length} acts`)
    }

    // **The answer to a press outlives the next frame.** A node carrying both
    // what came of a press and a fact about the harness would have the delta
    // two seconds later rewrite the second and take the first with it — so
    // this is asked of `steer`, which is the control with something to say on
    // every frame, after a wait longer than a beat.
    const quiet = String(await page.evaluate(STATUS))
    await page.locator('textarea[aria-label="what to tell its agent"]').first().fill('go on then')
    await page.locator('button', { hasText: 'Send' }).first().tap()
    await until(page, `${STATUS} !== ${JSON.stringify(quiet)}`)
    const answered = String(await page.evaluate(STATUS))
    // **A real delta, pushed**, because the thing being checked is what a
    // frame does to the answer: nothing in this harness beats, so a wait alone
    // would pass whatever the page did. The row that moves is the one the
    // controls are on.
    await nudge(server, held, device)
    await until(page, RECEIVED)
    const later = String(await page.evaluate(STATUS))
    if (later === answered) {
      found('typing', `${at} kept`, 'pass', 'the answer to a press outlived a real delta')
    } else {
      found('typing', `${at} kept`, 'fail', `"${answered}" became "${later}"`)
    }

    // What somebody typed, against a refusal.
    const words = 'the fix is in the adapter'
    const box = page.locator('textarea[aria-label="what to write down"]').first()
    await box.fill(words)
    await page.locator('button', { hasText: 'Write it down' }).first().tap()
    await until(page, SAID_MOVED)
    const kept = await box.inputValue()
    if (kept === words) {
      found('typing', at, 'pass', 'a refusal left what was typed where it was')
    } else {
      found('typing', at, 'fail', `the box holds "${kept}" after a refusal`)
    }
  } catch (problem) {
    for (const check of ['controls', 'touch', 'typing']) found(check, at, 'fail', said(problem))
  }
  // **The command bar, tapped**: this is the one page with a touch screen,
  // and the keyboard's own check cannot tell a row from what covers it.
  await paletteTappedAt(page as never, origin, at, found)
  // **The installed shell, on this same device**: pairing is rate limited per
  // address, the five tries are spent, and this is the right phone to ask
  // anyway — narrow, touch, granted (`browser-pwa.ts`).
  // **Queued work down the side, pressed**, on this same device: it may steer,
  // so the queue's choices are on its menu (`browser-queue.ts`).
  await queueAt(page as never, origin, found, asked, QUEUED.id)
  await asPwa({ context, origin, found })
  // **The Machines page, on this same device**, every paired device being the
  // person's own, since a sixth pairing would be refused (`browser-machines.ts`).
  await machinesAt(page as never, origin, found, {
    machines: (MACHINES.columns ?? []).map((one) => one.machine),
    rows: MACHINES.rows.map((one) => ({ label: one.label, cells: one.cells.length })),
  })
  // **The Accounts page, on the same device**: a tab per machine, each one's
  // accounts drawn when it is pressed, and both fitting (`browser-accounts.ts`).
  await accountsAt(page as never, origin, found, {
    tabs: ['mac · here', 'vps'],
    accounts: [
      ['its own sign-in', 'work', 'its own sign-in'],
      ['its own sign-in', 'deploy-bot'],
    ],
  })
  await context.close()
}

/** What `deltaUnder` and `asActing` both need of the listener. */
interface Served {
  streams: {
    push: (device: string, delta: never, now: number) => void
    listening: () => string[]
  }
}

/**
 * Move the projection under a page, for real, and push the delta.
 *
 * One task's `reason` changes — a field on the very row the controls are on —
 * so what arrives is a patch to a node the page already built, which is the
 * shape every delta has and the shape that would wipe a status node carrying
 * two different kinds of fact.
 */
async function nudge(
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
  device: string,
): Promise<void> {
  const made = held.get(device)
  if (made === undefined) throw new Error('no projector for this device')
  const next = input({ talk: harnessTalk(), tasks: TASKS })
  const first = next.tasks[0]
  if (first === undefined) throw new Error('no task to move')
  const delta = made.beat(
    {
      ...next,
      tasks: [
        { ...first, reason: { kind: 'clause', said: 'moved under your hands' } },
        ...next.tasks.slice(1),
      ],
    },
    NOW + 2_000,
  )
  if (delta === null) throw new Error('the projection did not move')
  server.streams.push(device, delta as never, Date.now())
}

/** How many lines `arrival` has sent after the harness's conversation, across every page. */
let arrived = 0

/**
 * Every call `busyWith` sent, as the window holds it once the turn moved on:
 * answered, in place under the same id. The window never drops a call it sent,
 * and the page keeps every line it was sent (`linesKept`), so a call left out
 * of a later beat would stay drawn as still going.
 */
const answered: ChatIn[] = []

/** The conversation the harness serves now: its own, the arrivals, and every call answered. */
const harnessNow = (): TalkIn => {
  const talking = harnessTalk(arrived)
  return { ...talking, lines: [...talking.lines, ...answered].sort((a, b) => a.at - b.at) }
}

/** Every line's id of the conversation the harness serves now, oldest first. */
const heldLines = () => harnessNow().lines.map((line) => line.id)

/** What each device may read, as the listener last asked: a delta is projected under its own. */
const reaches = new Map<string, Reach>()

/**
 * One more line of the conversation, sent to this page's device as a delta on
 * its stream — what Tade answering looks like from a phone.
 */
function arrival(
  page: Page,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
): () => Promise<void> {
  return async () => {
    const device = await deviceIn(page)
    if (device === null) throw new Error('the page never said which device this is')
    const made = held.get(device)
    if (made === undefined) throw new Error('no projector for this device')
    arrived += 1
    const reach = reaches.get(device)
    const delta = made.beat(
      input({
        ...(reach === undefined ? {} : { reach }),
        talk: harnessNow(),
        notes: NOTES,
      }),
      NOW + 2_000 + arrived,
    )
    if (delta === null) throw new Error('the conversation did not move')
    server.streams.push(device, delta as never, Date.now())
  }
}

/**
 * Tade answering, with a call still running as its last line: one more
 * arrival, as `arrival` sends it, with the turn in flight and the call after
 * it. The next beat ends the turn, with the call in it answered.
 */
function busyWith(
  page: Page,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
): (call: Running) => Promise<void> {
  return async (call) => {
    const device = await deviceIn(page)
    if (device === null) throw new Error('the page never said which device this is')
    const made = held.get(device)
    if (made === undefined) throw new Error('no projector for this device')
    arrived += 1
    const reach = reaches.get(device)
    const talking = harnessNow()
    // Half a second after this arrival's line, so it is the last until the next.
    const at = Date.parse('2026-10-08T13:00:00.000Z') + (10_000 + arrived - 1) * 1000 + 500
    const running: ChatIn = {
      id: `${new Date(at).toISOString()}#0`,
      at,
      kind: 'tool',
      from: '',
      text: '',
      tool: call.tool,
      outcome: 'running',
      call: { input: call.input, result: null },
      streaming: false,
    }
    const delta = made.beat(
      input({
        ...(reach === undefined ? {} : { reach }),
        talk: { ...talking, busy: true, whose: 'device aa', lines: [...talking.lines, running] },
        notes: NOTES,
      }),
      NOW + 2_000 + arrived,
    )
    if (delta === null) throw new Error('the conversation did not move')
    server.streams.push(device, delta as never, Date.now())
    answered.push({ ...running, outcome: 'ok', call: { input: call.input, result: 'ran' } })
  }
}

/** Which device this page is signed in as, out of the devices screen. */
async function deviceIn(page: Page): Promise<string | null> {
  const got = await page.evaluate(`fetch('/api/devices').then((r) => r.json())`)
  const found_ = (got as { you?: { device?: string } } | null)?.you?.device
  return typeof found_ === 'string' && found_ !== '' ? found_ : null
}

/**
 * Pairing, through the page a person actually uses.
 *
 * The ticket arrives in the fragment, which is what a scanned code carries, and
 * the button is pressed rather than the cookie planted — so what this proves is
 * the flow, not the server's own `POST`, which `pairing.test.ts` already covers
 * from the other side.
 */
async function pairIn(page: Page, origin: string, ticket: string, at: string) {
  try {
    await page.goto(`${origin}/pair#t=${ticket}`, { waitUntil: READY })
    await page.waitForSelector('#label', { timeout: 10_000 })
    await page.fill('#label', 'the harness')
    await page.click('button.pair-press')
    await page.waitForURL(`${origin}/`, { timeout: 15_000 })
    await page.waitForSelector('header .brand', { timeout: 10_000 })
    // And the ticket is gone from the address bar, which is rule two of the
    // whole client.
    const held = await page.evaluate('location.hash')
    if (held !== '') throw new Error(`the ticket stayed in the address bar: ${String(held)}`)
    found('pairing', at, 'pass', 'scanned, named, let in, and the ticket left the address bar')
  } catch (problem) {
    found('pairing', at, 'fail', said(problem))
  }
}

interface Bad {
  id: string
  impact: string
  nodes: number
  /** Which elements, so a failure is a thing somebody can go and look at. */
  at: string
}

interface Shape {
  /** Everything a reader would see, for the sentences that may not be here. */
  words: string
  landmarks: string[]
  mains: number
  live: number
  skip: string
  sideways: number
  room: number
  /** How much wider than itself the screen's own content is. */
  within: number
  small: string[]
}

/** What `CUT` found: each element drawn cut, each rule asking to, and the folds with their mark. */
interface Clipped {
  cut: string[]
  rules: string[]
  folds: number
}

async function lookAt(
  page: Page,
  origin: string,
  look: { path: string; name: string },
  width: { name: string; narrow?: true },
  axe: string | null,
) {
  const where = `${look.name} @ ${width.name}`
  try {
    await page.goto(`${origin}${look.path}`, { waitUntil: READY })
    await page.waitForSelector('main', { timeout: 10_000 })
  } catch (problem) {
    found('landmarks', where, 'fail', said(problem))
    return
  }

  const shape = (await page.evaluate(SHAPE)) as Shape
  const missing = ['header', 'nav', 'main'].filter((one) => !shape.landmarks.includes(one))
  if (missing.length > 0 || shape.mains !== 1) {
    found('landmarks', where, 'fail', `missing ${missing.join(', ')}; ${shape.mains} main`)
  } else if (!shape.skip.toLowerCase().includes('skip')) {
    found('landmarks', where, 'fail', `the first focusable thing is "${shape.skip.trim()}"`)
  } else if (shape.live !== 1) {
    // One live region. Announcing more than what crossed into wanting you
    // reads the page aloud every two seconds.
    found('landmarks', where, 'fail', `${shape.live} live regions`)
  } else {
    found('landmarks', where, 'pass', 'header, nav, one main, one live region, skip link first')
  }

  // At every width: a desk that scrolled sideways is as broken as a phone.
  const over = Math.max(shape.sideways - shape.room, shape.within)
  if (over > 1) found('sideways', where, 'fail', `the page is ${over}px wider than the screen`)
  else found('sideways', where, 'pass', 'nothing scrolls sideways')

  if (shape.small.length > 0) {
    found('targets', where, 'fail', `too small to hit: ${shape.small.slice(0, 3).join('; ')}`)
  } else {
    found('targets', where, 'pass', 'every control is at least 44px tall')
  }

  // Nothing cut to fit, on this screen or in any rule it could draw with.
  const cut = (await page.evaluate(CUT(CUT_ALLOWED))) as Clipped
  const cuts = [...cut.cut, ...cut.rules.map((one) => `a rule asks for it: ${one}`)]
  if (cuts.length > 0) found('cut', where, 'fail', cuts.slice(0, 4).join('; '))
  else found('cut', where, 'pass', `nothing cut; ${cut.folds} folded with the mark that opens them`)

  const title = await page.title()
  if (title === '' || title === 'Tade') found('titles', where, 'fail', `the title is "${title}"`)
  else found('titles', where, 'pass', title)

  // **Nothing is withheld from a paired device**: every one is the person's
  // own, so a page that told one a thing was *not granted* is saying a thing
  // that is not true of any device.
  const withheld = NOT_FOR_A_GRANTED_DEVICE.filter((one) => shape.words.includes(one))
  if (withheld.length > 0) {
    found('granted', where, 'fail', `says ${withheld.join('; ')} to a paired device`)
  } else {
    found('granted', where, 'pass', 'nothing is said to be withheld')
  }

  if (axe !== null) await axeOn(page, where, axe)
  if (shots !== null) {
    await page.screenshot({ path: join(shots, `${width.name}-${look.name}.png`), fullPage: true })
  }
}

async function axeOn(page: Page, where: string, source: string) {
  try {
    // **Evaluated, not injected as a `<script>`.** The page's own content
    // policy has no `unsafe-inline`, so a script tag is refused — which is the
    // policy working. The debugger's own evaluation is not subject to it, so
    // this is the one way to run a checker against a page that is locked down
    // as hard as this one, and it is the reason the policy needs no exception
    // for a test.
    await page.evaluate(source)
    const bad = (await page.evaluate(AXE)) as Bad[]
    if (bad.length === 0) found('axe', where, 'pass', 'nothing serious or critical')
    else {
      const names = bad.map((one) => `${one.id} ${one.impact} ×${one.nodes} — ${one.at}`).join('; ')
      found('axe', where, 'fail', names)
    }
  } catch (problem) {
    found('axe', where, 'unrun', said(problem))
  }
}

/**
 * A real delta, into an open page, under somebody's hands.
 *
 * **The thing nothing else can check.** The page claims that a change arriving
 * twice a second does not take the keyboard's place or a half-made selection
 * with it, and that claim is about a *delta applied to a live document* — a
 * page loaded once never exercises it. So: focus a row, select some text in
 * it, move the projection, push the delta the server would really send, and
 * ask whether the same element is still focused with the same selection.
 *
 * The row's own text is changed in the same delta, so this is not the easy
 * case where nothing about the focused row moved.
 */
async function deltaUnder(
  page: Page,
  origin: string,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
  at: string,
) {
  const where = `a delta @ ${at}`
  try {
    // The agents' list, whose rows carry the reason the delta changes: the
    // overview at a desk hands its own list to the dock and draws cards, so a
    // list of rows to hold is on this screen at every width.
    await page.goto(`${origin}/agents`, { waitUntil: READY })
    await page.waitForSelector('main .rows li a', { timeout: 10_000 })
    // Focus the second row and select inside it, which is what a person
    // reading a list on a phone has actually done.
    const before = (await page.evaluate(HOLD)) as { key: string; words: string }
    if (before.key === '') throw new Error('nothing to hold on to on this page')

    const device = server.streams.listening()[0]
    if (device === undefined) throw new Error('no stream to push into')
    // The projection really moves: a task's reason changes, which is a field
    // on the very row being held.
    await nudge(server, held, device)
    await until(page, RECEIVED)

    const after = (await page.evaluate(HOLD_AGAIN)) as {
      key: string
      words: string
      rows: number
    }
    if (after.key !== before.key) {
      found('delta', where, 'fail', `focus moved from ${before.key} to ${after.key || 'nothing'}`)
      return
    }
    if (after.words !== before.words) {
      found('delta', where, 'fail', `the selection went: "${before.words}" to "${after.words}"`)
      return
    }
    found('delta', where, 'pass', `${after.rows} rows redrawn, focus and selection kept`)
  } catch (problem) {
    found('delta', where, 'fail', said(problem))
  }
}

function shotsDir(argv: readonly string[]): string | null {
  const at = argv.indexOf('--shots')
  return at < 0 ? null : (argv[at + 1] ?? join(SCRATCH, 'tade-away-shots'))
}

// **Refused before a browser is started**, rather than run and reported: a
// report made under another axe-core reads exactly like one made under the
// pinned one, and the difference is the verdict. Exit 2, `unrun` — nothing was
// looked at.
const axe = await axeSource()
const refused = axe.source === null ? null : axeRefused(axe.version)
if (refused !== null) {
  process.stderr.write(`${refused}\n`)
  process.exitCode = 2
} else {
  if (shots !== null) await mkdir(shots, { recursive: true })
  await run(axe)
  process.stdout.write(`${sayReport(findings)}\n`)
  if (shots !== null) process.stdout.write(`\npictures in ${shots}\n`)
  process.exitCode = exitFor(worstOf(findings))
}
