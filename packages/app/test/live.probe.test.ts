import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type TadeEvent, type Workspace } from '@tade/core'
import {
  gitLoad,
  makeCollector,
  REUSE_MS,
  type StatusAnswer,
  type StatusCollector,
} from '@tade/status'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { STANDS_MS } from '../src/checkout-look.ts'
import { Live } from '../src/live.ts'
import { spendPanel } from '../src/panels/spend/state.ts'
import type { Wiring } from '../src/wire/context.ts'
import { Spend } from '../src/wire/spend.ts'

// What a frame costs to say what has been spent today.
//
// `facts()` is read on every frame — four times a second, whether anything is
// happening or not — and it asked `spendToday()`, which folded every usage
// event of the last week. Twenty-four thousand of them on a week-old journal
// was 3% of a core, burned re-deriving a number that only moves when an agent
// spends something; on a window with no agents running, nothing ever does.
//
// `spendFrom` is pure and `usage` only ever grows, so the same events over the
// same day are the same answer, and the fold belongs once per event rather than
// once per frame. Asserted as a ratio against the first fold, never as a rate
// the machine has to hit: a slow machine makes both numbers bigger and this
// still means what it says.
//
// The Spend page below is the same shape one level out. It can now be asked for
// the whole journal rather than a week of it, and the page's own fold — money,
// runtime and budgets together — runs only while the page is open, which is
// exactly when somebody is watching the frame rate.

/** How many repeat reads to make the frame's cost out of. */
const REPEATS = 200

/**
 * What the repeats may cost, measured in cold folds.
 *
 * Two hundred folds of the week would be two hundred. Two hundred reads of a
 * memo is somewhere near zero, and three is the slack that leaves for a clock
 * read and a machine under load.
 */
const BUDGET = 3

/** Usage events, spread over today so the day window keeps all of them. */
function usage(home: string, events: number, at: number): void {
  const lines: string[] = []
  for (let seq = 1; seq <= events; seq++) {
    lines.push(
      JSON.stringify({
        seq,
        ts: new Date(at - (events - seq) * 1000).toISOString(),
        type: 'usage',
        urgency: 'routine',
        task: `app/task-${seq % 40}`,
        run: `run-${seq % 40}`,
        detail: {
          input: 100,
          output: 20,
          tokens: 120,
          usd: 0.0001,
          priced: 'exact',
          model: 'claude-opus-5',
          harness: 'pi',
        },
      }),
    )
  }
  writeFileSync(join(home, 'events.jsonl'), `${lines.join('\n')}\n`)
}

const opened: { live: Live; client: Workbench; status?: StatusCollector }[] = []

afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
    await one.status?.close().catch(() => {})
  }
})

/**
 * A `Live` over a home whose journal already holds a week of spending, and the
 * one door events reach it through.
 *
 * The listener is the workbench's own: `Live` registers it on `subscribe`, and
 * an appended event is handed to it exactly like this. Taking it here is what
 * lets a test spend something without driving a harness and a model to do it.
 */
async function liveOver(
  events: number,
  now: () => number,
): Promise<{ live: Live; spend: (event: Partial<TadeEvent>) => void }> {
  const home = mkdtempSync(join(tmpdir(), 'tade-spend-probe-'))
  usage(home, events, now())
  const client = await Workbench.open({ home })
  let heard: ((event: TadeEvent) => void) | null = null
  const watched = new Proxy(client, {
    get(target, key: string | symbol, receiver) {
      if (key !== 'subscribe') return Reflect.get(target, key, receiver)
      return async (fn: (event: TadeEvent) => void) => {
        heard = fn
        return await client.subscribe(fn)
      }
    },
  })
  const live = await Live.start({
    client: watched,
    config: ConfigSchema.parse({ projects: {} }),
    home,
    tadeHome: home,
    // Far longer than the test: what the beat looks at is not what is measured
    // here, and a probe racing a background refresh measures the refresh.
    pollMs: 600_000,
    now,
  })
  opened.push({ live, client })
  // The journal is read after the window is up, and the first look waits on
  // it: what was spent is unknown until then, and this is a probe of the fold.
  await live.refresh()
  // Numbered after the journal's last line, as the journal numbers them: an
  // event at or under a line the lists already held is one they counted.
  let seq = ((await client.events({ limit: 1 })).at(-1)?.seq ?? events) + 1
  return {
    live,
    spend: (event) =>
      heard?.({
        seq: seq++,
        ts: new Date(now()).toISOString(),
        urgency: 'routine',
        lane: null,
        run: null,
        task: null,
        ...event,
      } as TadeEvent),
  }
}

function millis(fn: () => void): number {
  const at = performance.now()
  fn()
  return performance.now() - at
}

describe('what a frame costs to say what was spent', () => {
  it('folds the week once, not once per frame', async () => {
    // Noon, so today's window holds everything written above it.
    const now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(20_000, () => now)

    const cold = millis(() => {
      live.spendToday()
    })
    const warm = millis(() => {
      for (let i = 0; i < REPEATS; i++) live.spendToday()
    })

    expect(warm).toBeLessThan(cold * BUDGET)
  })

  it('counts what was spent since the last frame', async () => {
    const now = Date.parse('2026-09-20T12:00:00Z')
    const { live, spend } = await liveOver(100, () => now)
    const before = live.spendToday()!.total.tokens
    expect(before).toBeGreaterThan(0)

    spend({
      type: 'usage',
      task: 'app/task-new',
      detail: { input: 5_000, output: 0, tokens: 5_000, usd: 1, priced: 'exact' },
    })

    expect(live.spendToday()!.total.tokens).toBe(before + 5_000)
  })

  it('starts the total again when the day does', async () => {
    let now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(100, () => now)
    expect(live.spendToday()!.total.tokens).toBeGreaterThan(0)

    // A window left open overnight must not go on showing yesterday's total:
    // what is spent today is a different question the moment today changes.
    now += 86_400_000
    expect(live.spendToday()!.total.tokens).toBe(0)
  })
})

/**
 * The Spend page's subject over a `Live`, with the panel open on a range.
 *
 * Only what the subject actually reaches: it asks the state for its panel, the
 * options for the config and the workbench, and the clock. Everything else on
 * `Wiring` belongs to other subjects and is never touched from here — which is
 * the narrowness `Wiring` exists for.
 */
function pageOver(live: Live, now: () => number, window: 'today' | 'all'): Spend {
  const wiring = {
    opts: {
      client: { planUsage: () => [] },
      config: ConfigSchema.parse({ projects: {} }),
    },
    state: { panel: { ...spendPanel(), window }, panes: [], known: [], projectOrder: [] },
    live,
    now,
    openedAt: now() - 3_600_000,
  } as unknown as Wiring
  return new Spend(wiring)
}

describe('what a frame costs to draw the Spend page', () => {
  it('folds the range once a second, not once a frame', async () => {
    const now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(20_000, () => now)
    const page = pageOver(live, () => now, 'all')

    const cold = millis(() => {
      page.facts()
    })
    const warm = millis(() => {
      for (let i = 0; i < REPEATS; i++) page.facts()
    })

    expect(warm).toBeLessThan(cold * BUDGET)
  })

  it('folds it again the moment something is spent', async () => {
    const now = Date.parse('2026-09-20T12:00:00Z')
    const { live, spend } = await liveOver(100, () => now)
    const page = pageOver(live, () => now, 'all')
    const before = page.facts().spendView?.tokens ?? 0
    expect(before).toBeGreaterThan(0)

    spend({
      type: 'usage',
      task: 'app/task-new',
      detail: { input: 5_000, output: 0, tokens: 5_000, usd: 1, priced: 'exact' },
    })

    // Within the same second, so nothing but the new event can be what moved
    // it: a kept fold that waits out its second before counting what an agent
    // just spent is a page that lies for as long as it is quick.
    expect(page.facts().spendView?.tokens).toBe(before + 5_000)
  })

  it('starts the range again when the day does', async () => {
    // A window left open overnight must not go on drawing yesterday's morning
    // because nothing new was spent: a fold kept until something changes is
    // wrong about a range whose own edges moved while nobody looked.
    let now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(100, () => now)
    const page = pageOver(live, () => now, 'today')
    expect(page.facts().spendView?.tokens ?? 0).toBeGreaterThan(0)

    now += 86_400_000
    expect(page.facts().spendView?.tokens).toBe(0)
  })

  it('reads the whole journal where a range asks for it', async () => {
    // The range the page could not offer before: yesterday's turns are in the
    // journal and in no other range on the page, so `all` is the only answer
    // that holds them.
    let now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(100, () => now)
    now += 86_400_000
    expect(pageOver(live, () => now, 'today').facts().spendView?.tokens).toBe(0)
    expect(pageOver(live, () => now, 'all').facts().spendView?.tokens ?? 0).toBeGreaterThan(0)
  })
})

describe('what a frame costs to say how long the agents ran', () => {
  // The same fold as spend, over the run events instead — with the one
  // difference that a run still going counts up with the clock. It is drawn
  // to the second, so it is folded again each second something runs, and not
  // otherwise.
  const noon = Date.parse('2026-09-20T12:00:00Z')
  const started = (task: string, at: number): Partial<TadeEvent> => ({
    type: 'run_started',
    ts: new Date(at).toISOString(),
    task,
    lane: `${task}/agent`,
    run: `${task}/agent`,
    detail: { harness: 'pi', model: 'claude-opus-5' },
  })

  it('is folded once while nothing runs, however much time goes by', async () => {
    let now = noon
    const { live, spend } = await liveOver(1, () => now)
    spend(started('app/one', noon - 600_000))
    spend({ type: 'run_exited', task: 'app/one', lane: 'app/one/agent', run: 'app/one/agent' })
    const first = live.runtimeToday()!
    expect(first.total.running).toBe(false)
    expect(first.total.ms).toBe(600_000)
    now += 3_600_000
    expect(live.runtimeToday()).toBe(first)
  })

  it('counts up a second at a time while a run goes on, and at once when one starts', async () => {
    let now = noon
    const { live, spend } = await liveOver(1, () => now)
    spend(started('app/one', noon - 60_000))
    const first = live.runtimeToday()!
    expect(first.total).toMatchObject({ running: true, ms: 60_000 })
    // Inside the same second there is nothing new to draw.
    now += 999
    expect(live.runtimeToday()).toBe(first)
    now += 1
    expect(live.runtimeToday()!.total.ms).toBe(61_000)
    // A second run counts from the moment it is heard of, not the next second.
    spend(started('app/two', now - 5_000))
    expect(live.runtimeToday()!.total.ms).toBe(66_000)
  })
})

/**
 * Status as a window's child answers it, with the look itself held still: the
 * first answer is the real collector's over the real repository, and every one
 * after it says the same thing — a new object with a new stamp, as a real look
 * is — until the test changes what it says (`say`). A look is git, and the
 * probes below count git: one that looked for real on every beat would be
 * counting status rather than the window.
 */
function heldStatus(): StatusCollector & { say(change: (world: Workspace) => void): void } {
  const real = makeCollector('here')
  let first: Extract<StatusAnswer, { known: true }> | null = null
  return {
    id: 'held',
    async collect(ask) {
      if (!first) {
        const answer = await real.collect(ask)
        if (!answer.known) return answer
        first = answer
      }
      const world = structuredClone(first.workspace)
      return { ...first, workspace: { ...world, generatedAt: new Date().toISOString() } }
    },
    close: () => real.close(),
    say(change) {
      if (first) change(first.workspace)
    },
  }
}

/**
 * A `Live` over a repository with one agent in a worktree of its own, on a
 * clock the test moves, and status held still. `beat` is what an idle window
 * does every two seconds: the side read as a frame reads it — the marks, the
 * changes and the branch of one checkout — and the looks that found due.
 * `tell` is status's next look finding the agent's tree changed as `codes`
 * says (git's `XY` by path), and the window hearing it.
 */
async function checkoutOver(
  over: { onTasks?: (moved: boolean) => void; onTerminals?: () => void } = {},
) {
  const repo = mkrepo()
  repo.commit('first', { 'ledger.ts': 'one\n' })
  repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
  const home = tmp('tade-checkout-probe-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  const client = await Workbench.open({ home })
  const status = heldStatus()
  let now = Date.parse('2026-09-20T12:00:00Z')
  const live = await Live.start({
    client,
    config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
    home,
    tadeHome: repo.home,
    pollMs: 600_000,
    now: () => now,
    status,
    ...(over.onTasks ? { onTasks: (_: unknown, moved: boolean) => over.onTasks?.(moved) } : {}),
    ...(over.onTerminals ? { onTerminals: over.onTerminals } : {}),
  })
  opened.push({ live, client, status })
  await live.refresh()
  const beat = async (root: string, base: string | null) => {
    now += 2_000
    live.marksAt(root)
    live.changesAt(root, base)
    live.branchAt(root)
    await live.lookAgain()
  }
  /** How many `git`s one beat started. */
  const asked = async (root: string, base: string | null) => {
    const was = gitLoad().started
    await beat(root, base)
    return gitLoad().started - was
  }
  const tell = async (codes: Record<string, string>) => {
    status.say((world) => {
      const task = world.projects[0]?.tasks.find((one) => one.id === 'app/refunds')
      if (task?.git) Object.assign(task.git, { dirty: Object.keys(codes).sort(), xy: codes })
    })
    await live.refresh(false)
  }
  return { repo, live, status, beat, asked, tell, base: live.baseOf('app/refunds') }
}

/** How many `git status`es have been started, by anybody. */
const statuses = () => gitLoad().commands.status ?? 0

describe('what an idle window costs to keep a checkout looked at', () => {
  // The FILES tree's marks, CHANGES and the branch were asked of git every two
  // seconds whatever had happened: four or five `git`s a beat, about two a
  // second, on a window nobody was touching. Now a beat reads a signature
  // first (`checkout-look.ts`) and asks git only where it moved.
  //
  // Counted in beats on a clock the test moves, never over a sleep: what is
  // asserted is how many `git`s a beat starts, which a slow machine does not
  // change.

  it('asks git nothing on a beat whose checkout has not moved, until its ceiling', async () => {
    const { live, beat, asked, base } = await checkoutOver()
    const root = live.worktreeOf('app/refunds') as string
    // The first look at each is git, and an answer.
    expect(await asked(root, base)).toBeGreaterThan(0)
    const before = gitLoad().started
    // Every beat for most of a minute, with nobody touching anything.
    for (let beats = 1; beats < STANDS_MS / 2_000; beats++) await beat(root, base)
    expect(gitLoad().started - before, 'git asked about a checkout nobody touched').toBe(0)
    // And asked again at the ceiling: a signature is not a promise.
    expect(await asked(root, base)).toBeGreaterThan(0)
  })

  it('looks again on the beat after the checkout moves, however it moved', async () => {
    const { repo, live, tell, beat, asked, base } = await checkoutOver()
    const root = live.worktreeOf('app/refunds') as string
    const changed = () => live.changesAt(root, base)?.map((one) => `${one.path} +${one.added}`)
    await asked(root, base)
    expect(changed()).toEqual([])

    // A file nobody had changed, changed in place: nothing a stat of `.git`
    // or of the folder sees. It is what status says next that tells.
    writeFileSync(join(root, 'ledger.ts'), 'one\ntwo\n')
    expect(await asked(root, base), 'the blind spot status covers').toBe(0)
    await tell({ 'ledger.ts': '.M' })
    expect(await asked(root, base)).toBeGreaterThan(0)
    expect(changed()).toEqual(['ledger.ts +1'])

    // Changed again: a file already changed, whose counts move and nothing else.
    writeFileSync(join(root, 'ledger.ts'), 'one\ntwo\nthree\n')
    expect(await asked(root, base)).toBeGreaterThan(0)
    expect(changed()).toEqual(['ledger.ts +2'])

    // A new file: in CHANGES when status says so, since a diff cannot see one.
    writeFileSync(join(root, 'teapot.yaml'), 'short\n')
    await tell({ 'ledger.ts': '.M', 'teapot.yaml': '??' })
    expect(changed()).toContain('teapot.yaml +null')
    // And the folder's own stat moved, so the diff is asked for again.
    expect(await asked(root, base)).toBeGreaterThan(0)

    // Committed: the index and HEAD.
    repo.git('-C', root, 'add', '-A')
    repo.git('-C', root, 'commit', '-q', '-m', 'the teapot')
    await tell({})
    expect(await asked(root, base)).toBeGreaterThan(0)
    // And quiet again once each reader has looked at what the commit left: the
    // branch on its own ten seconds, and the one look more that an answer
    // naming other paths than the last costs, since its signature is new.
    for (let beats = 0; beats < 5; beats++) await beat(root, base)
    expect(await asked(root, base)).toBe(0)
  })

  it('stands no longer than status’s own gate on a checkout no agent works in', async () => {
    // The project's own checkout, where its one agent does not work: status
    // says nothing of it, so the only thing that can see an edit in place is a
    // look, and the answer stands only as long as status would let its own.
    // That look is the window's own `git status`, for the marks and the new
    // files, because nothing else has run one there.
    const { repo, beat, asked } = await checkoutOver()
    const was = statuses()
    expect(await asked(repo.root, null)).toBeGreaterThan(0)
    expect(statuses() - was, 'nobody said what is in a checkout status does not watch').toBe(2)
    const before = gitLoad().started
    for (let beats = 1; beats < REUSE_MS / 2_000; beats++) await beat(repo.root, null)
    expect(gitLoad().started - before).toBe(0)
    expect(await asked(repo.root, null)).toBeGreaterThan(0)
  })
})

describe('what a window asks git of a tree status already looks at', () => {
  // Status runs `git status` on every tree an agent works in, behind its own
  // gate, and the window ran the same command on the same tree twice more
  // every two seconds: once for the FILES tree's marks and once for CHANGES.
  // Both now come out of what status said (`GitSnapshot.xy`); the window asks
  // git only for the diff from the base, which status does not take.

  it('runs no `git status` of its own, and draws what status said', async () => {
    const { live, tell, beat, base } = await checkoutOver()
    const root = live.worktreeOf('app/refunds') as string
    const was = statuses()
    for (let beats = 0; beats < 5; beats++) await beat(root, base)
    writeFileSync(join(root, 'ledger.ts'), 'one\ntwo\n')
    writeFileSync(join(root, 'teapot.yaml'), 'short\n')
    await tell({ 'ledger.ts': '.M', 'teapot.yaml': '??' })
    for (let beats = 0; beats < 5; beats++) await beat(root, base)
    expect(statuses() - was, 'the window ran git status on a tree status looks at').toBe(0)
    expect(live.marksAt(root)).toEqual({ 'ledger.ts': 'M', 'teapot.yaml': 'U' })
    const drawn = live.changesAt(root, base)?.map((one) => `${one.mark} ${one.path}`)
    expect(drawn).toEqual(['M ledger.ts', '? teapot.yaml'])
  })

  it('hands a frame the same answer while status says the same, through news about anything else', async () => {
    // A region is kept over identity (`view/last-frame.ts`), and these are read
    // in every frame: made again per beat, the side would be drawn again on
    // every beat that was news for some other reason.
    const { live, status, tell, beat, base } = await checkoutOver()
    const root = live.worktreeOf('app/refunds') as string
    writeFileSync(join(root, 'teapot.yaml'), 'short\n')
    await tell({ 'teapot.yaml': '??' })
    await beat(root, base)
    const marks = live.marksAt(root)
    const changes = live.changesAt(root, base)
    status.say((world) => {
      const task = world.projects[0]?.tasks.find((one) => one.id === 'app/refunds')
      if (task) task.reason = 'something new'
    })
    const revision = live.revision
    await live.refresh(false)
    expect(live.revision, 'the beat was not news').toBeGreaterThan(revision)
    await beat(root, base)
    expect(live.marksAt(root)).toBe(marks)
    expect(live.changesAt(root, base)).toBe(changes)
    // And a new one the moment status says something new about the tree.
    await tell({ 'teapot.yaml': '??', 'ledger.ts': '.M' })
    expect(live.marksAt(root)).not.toBe(marks)
    expect(live.changesAt(root, base)).not.toBe(changes)
  })
})

describe('what an idle window draws on the status beat', () => {
  // Every beat redrew the window and moved `revision`, whatever status said —
  // which made every answer kept on `revision` (`wire/kept.ts`) one made again
  // every two seconds, and was most of the ~0.7 frames a second an idle window
  // drew. A beat is news only where it found something the last did not.

  it('is not news, and moves nothing kept, when it found what the last one did', async () => {
    const moved: boolean[] = []
    let tabs = 0
    const { live, status } = await checkoutOver({
      onTasks: (one) => moved.push(one),
      onTerminals: () => {
        tabs++
      },
    })
    expect(moved.at(-1), 'the first look is news').toBe(true)
    const revision = live.revision
    const tasks = live.tasks
    const said = moved.length
    for (let beats = 0; beats < 5; beats++) await live.refresh(false)
    // The beat still runs — the queue, the schedules — and says it found nothing.
    expect(moved.slice(said)).toEqual([false, false, false, false, false])
    expect(live.revision, 'a beat that found nothing moved revision').toBe(revision)
    expect(live.tasks, 'a beat that found nothing made the tasks again').toBe(tasks)
    expect(tabs, 'the lower pane’s tabs were said again').toBe(1)

    // What status says differently is news on the beat that hears it.
    status.say((world) => {
      const task = world.projects[0]?.tasks.find((one) => one.id === 'app/refunds')
      if (task) task.reason = 'something new'
    })
    await live.refresh(false)
    expect(moved.at(-1)).toBe(true)
    expect(live.revision).toBeGreaterThan(revision)
    expect(live.tasks).not.toBe(tasks)

    // And a look somebody asked for is drawn whatever it found: whoever asked
    // has just changed something and is waiting to see it.
    await live.refresh()
    expect(moved.at(-1)).toBe(true)
  })
})
