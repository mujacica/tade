import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuns } from '@tade/checks-core'
import { ConfigSchema, recordsDir, type TaskId } from '@tade/core'
import { LINEAR_APP, LINEAR_APP_IN } from '@tade/extension-intake'
import { ExtensionHost } from '@tade/extensions-core'
import { makeCollector, type StatusCollector } from '@tade/status'
import { AUTH_BYTES, appendPush, generateVapid, P256DH_BYTES, scriptedPusher } from '@tade/web'
import { BATCH_BY, readTaskFile, Workbench } from '@tade/workbench'
import { recordConfigChanges } from '@tade/workbench/config-changes'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { parse, stringify } from 'yaml'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../test/fixtures/workflow.ts'
import {
  Heart,
  NOBODY_TO_TELL,
  type Said,
  saidLine,
  saidSince,
  WHILE_STARTING,
} from '../src/heart.ts'
import type { Entry, ThinkerEvent } from '../src/transcript.ts'
import type { AppOptions } from '../src/wire/context.ts'
import { LINEAR_CONNECTED_BY } from '../src/wire/linear-tokens.ts'
import { COOKIE, DEVICE, freePort, paired } from './wire/away-harness.ts'
import { SPAWNING_MS, until } from './wire/harness.ts'

// The part of the window that runs with no screen (`heart.ts`), on its own:
// a real workbench over a real repository, and no terminal anywhere. What the
// window draws of the same work is held by the window's own tests — `queue`,
// `schedules`, `intake` under `test/wire` — which run through this part too.

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

/**
 * What loads a relative file: an import or a re-export that is not type-only,
 * and an import for its effect. One statement each, never across two — with no
 * semicolons to stop at, a pattern that may cross a line runs from one
 * statement into the next and follows a type-only import it was never in.
 */
const LOADS = [
  /^import (?!type )(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\* as [\w$]+|[\w$]+) from '(\.[^']+)'/gm,
  /^import '(\.[^']+)'/gm,
  /^export (?!type )(?:\{[^}]*\}|\*(?: as [\w$]+)?) from '(\.[^']+)'/gm,
]

/** Every file of this package the heart reaches, following relative imports from `heart.ts`. */
function reached(): Set<string> {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const loads of LOADS)
      for (const found of text.matchAll(loads)) walk(resolve(dirname(file), found[1] ?? ''))
  }
  walk(join(src, 'heart.ts'))
  return seen
}

describe('the heart reaches nothing that takes a terminal', () => {
  it('loads neither the window nor the screen it paints, and makes no terminal anywhere', () => {
    const files = reached()
    expect(files.has(join(src, 'heart.ts'))).toBe(true)
    // What it is there to run, so the walk is known to have walked.
    for (const one of [
      'live.ts',
      'wire/queue.ts',
      'wire/schedules.ts',
      'wire/intake.ts',
      'wire/orchestrator.ts',
      'wire/web.ts',
      'wire/web-push.ts',
      'wire/settings.ts',
    ])
      expect(files.has(join(src, one))).toBe(true)
    // The face, the files that take the terminal — the window and its paint —
    // and the screen a form borrows it for.
    for (const one of [
      'app.ts',
      'wire/paint.ts',
      'wire/keyboard.ts',
      'wire/mouse.ts',
      'wire/screens.ts',
      'screen.ts',
    ])
      expect(files.has(join(src, one))).toBe(false)
    const takes =
      /import \{[^}]*\b(ProcessTerminal|TuiAltScreen|TUI)\b[^}]*\} from '@earendil-works\/pi-tui'/
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(takes)
  })
})

describe('what is said where nothing draws it', () => {
  const tade = (text: string, at = 0): Said => ({ kind: 'tade', text, at })

  it('is each line the conversation gained, once, and never what it already had', () => {
    const one = tade('one')
    const two = tade('two')
    const asked: Entry = { kind: 'you', text: 'hi', images: [], at: 0, from: 'device 00aa' }
    expect(saidSince([], [one])).toEqual([one])
    expect(saidSince([one], [one, asked, two])).toEqual([asked, two])
    const same = [one]
    expect(saidSince(same, same)).toEqual([])
    // The oldest falling off the front is not a line said.
    expect(saidSince([one, two], [two])).toEqual([])
    // Nor is what was read back out of the record and put above: it was said long ago.
    const before = tade('read back')
    expect(saidSince([one, two], [before, one, two])).toEqual([])
    expect(saidSince([one, two], [before, one, two, asked])).toEqual([asked])
  })

  it("is the orchestrator's words once they are whole, and a tool once it has answered", () => {
    const arriving: Entry = {
      kind: 'said',
      text: 'On i',
      streaming: true,
      by: 'orchestrator',
      at: 0,
    }
    const whole: Entry = { ...arriving, text: 'On it.', streaming: false }
    const running: Entry = {
      kind: 'tool',
      id: 'call_1',
      tool: 'tade_queue',
      detail: '',
      state: 'running',
      result: '',
      progress: null,
      at: 0,
    }
    const answered: Entry = { ...running, state: 'ok' }
    // Neither is said while it is still moving: a reply a word at a time, or a
    // tool that has not answered, would be a line per piece of it.
    expect(saidSince([], [arriving, running])).toEqual([])
    expect(saidSince([arriving, running], [whole, answered])).toEqual([whole, answered])
    // A suggestion is something to click, and there is nothing to click.
    const offer: Entry = { kind: 'suggestion', text: 'ask', ask: 'what did it find?', at: 0 }
    expect(saidSince([], [offer])).toEqual([])
  })

  it('is written with its time, trouble marked as the conversation marks it, and made printable', () => {
    const at = new Date(2026, 9, 17, 9, 5).getTime()
    expect(saidLine(tade('started app/refunds: it was ready', at))).toBe(
      '09:05 started app/refunds: it was ready',
    )
    expect(saidLine({ kind: 'problem', text: `a ticket \x1b[31mred\x1b[0m`, at })).toBe(
      '09:05 ✗ a ticket ␛red␛',
    )
  })

  it('says who said it where it was not Tade, on one line', () => {
    const at = new Date(2026, 9, 17, 9, 5).getTime()
    expect(
      saidLine({
        kind: 'said',
        text: 'Parked it.\nIt waits for you.',
        streaming: false,
        by: 'orchestrator',
        at,
      }),
    ).toBe('09:05 orchestrator: Parked it. It waits for you.')
    expect(
      saidLine({ kind: 'you', text: 'park the flaky one', images: [], at, from: 'device 00aa' }),
    ).toBe('09:05 device 00aa: park the flaky one')
    const tool = {
      kind: 'tool',
      id: 'call_1',
      tool: 'tade_proposal_decide',
      detail: 'app/bring-in-shed',
      result: '',
      progress: null,
      at,
    } as const
    expect(saidLine({ ...tool, state: 'ok' })).toBe(
      '09:05 orchestrator ran tade_proposal_decide app/bring-in-shed: done',
    )
    expect(saidLine({ ...tool, state: 'failed', result: 'not yours to start' })).toBe(
      '09:05 orchestrator ran tade_proposal_decide app/bring-in-shed: failed — not yours to start',
    )
  })
})

describe('the heart, with no screen', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  let heart: Heart | null = null
  let said: Said[] = []

  beforeEach(async () => {
    repo = mkrepo()
    repo.commit('first')
    home = repo.home
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
    said = []
  })

  afterEach(async () => {
    const [was, workbench] = [heart, client]
    heart = null
    await was?.stop().catch(() => {})
    await workbench?.close().catch(() => {})
  })

  const alone = async (over: Partial<AppOptions> = {}): Promise<Heart> => {
    heart = await Heart.alone(
      {
        client,
        config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
        home,
        cwd: repo.root,
        ...over,
      },
      (line) => said.push(line),
    )
    return heart
  }
  const sayings = () => said.flatMap((line) => (line.kind === 'tool' ? [] : [line.text]))

  /** The catalogue's Sentry server, on, brokered as the extension it is made into. */
  const sentryOn = async () => {
    const settings = {
      projects: { app: { root: repo.root } },
      mcp: { servers: { sentry: { enabled: true } } },
    }
    writeFileSync(join(home, 'config.yaml'), stringify(settings))
    const config = ConfigSchema.parse(settings)
    const search = {
      name: 'mcp_sentry_search_issues',
      description: 'Search issues.',
      parameters: { type: 'object' as const, properties: {} },
      for: ['agent' as const, 'orchestrator' as const],
      run: async () => ({ text: 'two issues' }),
    }
    const extensions = await ExtensionHost.load({
      brokered: [
        { name: 'mcp-sentry', title: 'Sentry (MCP)', description: 'Sentry.', tools: [search] },
      ],
      config: { extensions: config.extensions, projects: config.projects },
      home,
      env: {},
    })
    return { settings, config, extensions, search }
  }

  /** A server switched from a terminal while the heart holds the journal: the line waits in the spool. */
  const switchedThere = async (settings: object, name: string, on: boolean) => {
    writeFileSync(
      join(home, 'config.yaml'),
      stringify({ ...settings, mcp: { servers: { [name]: { enabled: on } } } }),
    )
    const change = {
      path: `mcp.servers.${name}.enabled`,
      was: String(!on),
      now: String(on),
      by: 'cli',
    }
    expect(await recordConfigChanges(home, [change])).toBe('spool')
    return change
  }

  // `tade mcp disable` on the server: the beat writes its line down and takes
  // the server off the way the Extensions page's own switch does — then and
  // there, not at a restart — and the orchestrator is started again on what it
  // can still call.
  it('writes the person’s own words down as theirs, with no keyboard to do it', async () => {
    // Their own device's line, or one typed on this machine's tab from
    // another of theirs, reaches the orchestrator as `theirSaid`: under
    // `tade serve` that was dropped, so no setting could ever be named.
    const one = await alone()
    one.orchestrator.theirSaid('watch the rehearsal requests on app')
    await until('the said line', async () =>
      (await client.events({ types: ['said'] })).some(
        (line) => line.detail.text === 'watch the rehearsal requests on app',
      ),
    )
  })

  it('turns a server off that a terminal turned off, on its next beat, with no screen', async () => {
    const { settings, config, extensions, search } = await sentryOn()
    const ended: (boolean | undefined)[] = []
    let restarted = 0
    await alone({
      config,
      extensions,
      endServers: async (servers) => void ended.push(servers.sentry?.enabled),
      restartThinker: async () => {
        restarted++
      },
    })
    expect(extensions.specs('orchestrator')).toHaveLength(1)
    const change = await switchedThere(settings, 'sentry', false)
    await until('the server off', () => extensions.specs('orchestrator').length === 0)
    await expect(
      extensions.call(search.name, {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow('Sentry (MCP) is off: turned off')
    // Its session ended with it, rather than when Tade stops.
    expect(ended).toContain(false)
    await until('the orchestrator started again on what is left', () => restarted === 1)
    const lines = (await client.events({ types: ['config_changed'] })).map(({ detail }) => detail)
    expect(lines).toContainEqual(expect.objectContaining(change))
  })

  // `tade mcp enable` on the server: taken as the page takes it, which is to
  // connect the next time Tade starts and never now — and the log says so,
  // since there is no page to say it on.
  it('says in the log that a server a terminal turned on connects the next time Tade starts', async () => {
    const settings = {
      projects: { app: { root: repo.root } },
      mcp: { servers: { sentry: { enabled: false } } },
    }
    writeFileSync(join(home, 'config.yaml'), stringify(settings))
    const config = ConfigSchema.parse(settings)
    const extensions = await ExtensionHost.load({
      config: { extensions: config.extensions, projects: config.projects },
      home,
      env: {},
    })
    const running = await alone({ config, extensions })
    await switchedThere(settings, 'sentry', true)
    await until('the log says when it connects', () =>
      sayings().includes(
        'sentry was turned on from a terminal — it connects the next time Tade starts',
      ),
    )
    // Taken, and nothing connected meanwhile: turning one on is never a hot reload.
    expect(running.wire.opts.config.mcp.servers.sentry?.enabled).toBe(true)
    expect(extensions.list().some((one) => one.name === 'mcp-sentry')).toBe(false)
  })

  // `tade config` over SSH, on a box whose only window is `tade serve`: any
  // setting a terminal changes is taken on the beat, as a window takes one of
  // its own — here where the workbench starts the next agent — and not only
  // a server's switch.
  it('takes a setting a terminal changed, on its next beat, with no screen', async () => {
    const settings = { projects: { app: { root: repo.root } }, agents: { workspace: 'worktree' } }
    await alone()
    expect(client.config.agents.workspace).toBe('checkout')
    writeFileSync(join(home, 'config.yaml'), stringify(settings))
    const change = { path: 'agents.workspace', was: '', now: 'worktree', by: 'cli' }
    expect(await recordConfigChanges(home, [change])).toBe('spool')
    await until('the workbench told', () => client.config.agents.workspace === 'worktree')
    const lines = (await client.events({ types: ['config_changed'] })).map(({ detail }) => detail)
    expect(lines).toContainEqual(expect.objectContaining(change))
  })

  // What Connect Linear hands over (`/connect`, `web-connect.ts`) is held by
  // the heart: a Linear source reads with that token rather than only with
  // LINEAR_API_KEY, and the refresh token is written through the one door and
  // taken by everything that holds the config — with no screen.
  it('reads a Linear source with the token Connect Linear handed over, and keeps its refresh token', async () => {
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'tracker',
          title: 'Tracker',
          description: 'Reads Linear.',
          tools: [
            {
              name: 'tracker_token',
              description: 'The Linear token it would read with.',
              parameters: { type: 'object', properties: {} },
              for: ['orchestrator'],
              run: async (_input, ctx) => ({ text: String(await ctx.connected?.('linear')) }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
    })
    const running = await alone({ extensions })
    const asked = () => extensions.call('tracker_token', {}, { caller: { kind: 'orchestrator' } })
    expect((await asked()).text).toBe('null')
    expect(
      await running.linear.took({ access: 'lin_oauth', refresh: 'lin_refresh', expiresIn: 86_400 }),
    ).toBeNull()
    expect((await asked()).text).toBe('lin_oauth')
    const kept = parse(readFileSync(join(home, 'config.yaml'), 'utf8'))
    expect(kept.extensions[LINEAR_APP_IN][LINEAR_APP.refresh.key]).toBe('lin_refresh')
    expect(running.wire.opts.config.extensions[LINEAR_APP_IN]?.[LINEAR_APP.refresh.key]).toBe(
      'lin_refresh',
    )
    expect(client.config.extensions[LINEAR_APP_IN]?.[LINEAR_APP.refresh.key]).toBe('lin_refresh')
    // Written down as `set`, never as itself — after the write, which it never holds up.
    await until('the change written down', async () =>
      (await client.events({ types: ['config_changed'] })).some(
        ({ detail }) =>
          detail.path === `extensions.${LINEAR_APP_IN}.${LINEAR_APP.refresh.key}` &&
          detail.now === 'set' &&
          detail.by === LINEAR_CONNECTED_BY,
      ),
    )
  })

  // What a server most needs after a restart: closing let go of the lanes
  // rather than writing them off, so the registry says alive and the driver
  // cannot hand the lane back. That is `lost`, and the one thing opening is
  // allowed to start.
  it('opens again an agent that was working when it closed, where it left off', async () => {
    const worktree = repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge' })
    await client.startAgent({ task: 'app/refunds' as TaskId, cwd: worktree, prompt: '' })
    await client.close()
    client = await Workbench.open({ home })
    expect(client.lanes().find((lane) => lane.task === 'app/refunds')?.lost).toBe(true)
    await alone()
    const agents = () => client.lanes().filter((lane) => lane.kind === 'agent')
    await until(
      'it back where it left off',
      () => agents().some((lane) => lane.task === 'app/refunds' && lane.alive),
      SPAWNING_MS,
    )
    // Only that one, and nothing invented beside it.
    expect(agents().map((lane) => lane.task)).toEqual(['app/refunds'])
    expect(await client.events({ types: ['task_created'] })).toEqual([])
  })

  // An agent started with no words has no branch until it changes something,
  // and then one named for what it did — whichever door started it.
  it('gives a branch to an agent that started without one, at its first change', async () => {
    await client.close()
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\nagents:\n  workspace: worktree\n`,
    )
    client = await Workbench.open({ home })
    await alone({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        agents: { workspace: 'worktree' },
      }),
    })
    const task = await client.createTask({
      project: 'app',
      slug: 'agent-1',
      intent: '',
      detached: true,
      by: 'you',
    })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    expect(await client.events({ types: ['task_named'] })).toEqual([])
    writeFileSync(join(task.worktree, 'refunds.ts'), 'export const once = true\n')
    await until(
      'the branch named',
      async () => (await client.events({ types: ['task_named'] })).length === 1,
      SPAWNING_MS,
    )
    const [named] = await client.events({ types: ['task_named'] })
    expect(named).toMatchObject({ task: 'app/agent-1', detail: { branch: 'tade/agent-1' } })
  })

  it('starts queued work by its own rule on the beat, and says why in the log', async () => {
    const running = await alone()
    await until('the first look', () => running.live?.hasLooked === true)
    const answer = await running.queueTools().plan({
      project: 'app',
      said: 'charge once, then give refunds back',
      agents: [
        { name: 'charge-once', said: 'charge once', prompt: '', after: [], touches: ['charge.ts'] },
        {
          name: 'refund-back',
          said: 'then give refunds back',
          prompt: '',
          after: [{ agent: 'charge-once', why: 'both change charge.ts' }],
          touches: ['charge.ts'],
        },
      ],
    })
    expect(answer).toContain('Started charge-once.')
    expect(answer).toContain('Queued refund-back (after app/charge-once).')

    // Nobody asks and nothing draws: the first finishing is what starts the second.
    await client.markDone('app/charge-once', { by: 'you' })
    await until(
      'the second started',
      () => client.runs().some((run) => run.task === 'app/refund-back'),
      SPAWNING_MS,
    )
    await until('it said so', () =>
      sayings().includes('started app/refund-back: app/charge-once has finished'),
    )
    // Said once, though it was news for an orchestrator as well: there is none
    // here, and the conversation already said it in the same words.
    expect(sayings().filter((text) => text.startsWith(NOBODY_TO_TELL))).toEqual([])
    expect(sayings().filter((text) => text.includes('refund-back: app/charge-once'))).toHaveLength(
      1,
    )
  })

  it('runs a schedule that came due, and says what was only for the orchestrator', async () => {
    let clock = Date.now()
    const running = await alone({ now: () => clock })
    await running.queueTools().schedule({
      name: 'Morning brief',
      project: 'app',
      said: 'in a moment, tell me what happened',
      when: { at: new Date(clock + 60_000).toISOString() },
      ask: 'Say what the agents did, and what needs the person first.',
    })
    clock += 61_000
    await until(
      'it ran',
      async () => (await client.events({ types: ['schedule_fired'] })).length === 1,
    )
    await until('the log says so', () =>
      sayings().includes('Morning brief ran: the orchestrator is asked'),
    )
    // There is no orchestrator here: what it would have been asked is not let
    // go in silence.
    await until('what it was asked, said', () =>
      sayings().some(
        (text) =>
          text.startsWith(NOBODY_TO_TELL) &&
          text.includes('Say what the agents did, and what needs the person first.'),
      ),
    )
  })

  it('looks with a watch on its clock and parks what it finds for the orchestrator', async () => {
    let clock = Date.now()
    const found: { key: string; title: string }[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          watches: [
            {
              id: 'rain',
              title: 'Rain',
              means: 'Looks for rain, and starts an agent to bring the washing in.',
              every: '1h',
              check: async () => ({ found }),
              agent: (finding) => ({
                title: `bring in ${finding.key}`,
                prompt: `It is raining: ${finding.title}.`,
              }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await alone({ extensions, now: () => clock })
    // Turned on as a person's press turns it on: the orchestrator's tool would
    // need their words naming it (`mayWatch`), and there is nobody to say them.
    await client.setSchedule(
      {
        id: 'rain',
        name: 'Rain',
        project: 'app',
        said: 'watch for rain and bring the washing in',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'weather.rain', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: new Date(clock).toISOString(),
      },
      'you',
    )
    found.push({ key: 'shed', title: 'rain over the shed' })
    clock += 3_600_000 + 1_000
    await until('it looked and made the work', async () =>
      (await client.events({ types: ['watch_checked'] })).some(
        (event) => (event.detail as { found?: number }).found === 1,
      ),
    )
    await until('the work parked', async () =>
      Boolean((await readTaskFile(home, 'app/bring-in-shed'))?.parked),
    )
    // Nothing starts what was made for somebody to decide, and nobody is here to.
    expect(client.runs()).toEqual([])
    await until('the log names it for the orchestrator', () =>
      sayings().some(
        (text) => text.startsWith(NOBODY_TO_TELL) && text.includes('app/bring-in-shed'),
      ),
    )
  })

  it('runs the full checks once a batch on its beat, and says a red one is for the orchestrator', async () => {
    repo.commit('the gate', {
      [CI_WORKFLOW]: ciWorkflow([{ id: 'tests', run: 'test ! -e broken' }]),
    })
    const head = repo.commit('work of b\n\nTade-Task: app/b', { broken: 'yes' })
    const projects = { app: { root: repo.root, checks: { full: 'batched' } } }
    writeFileSync(join(home, 'config.yaml'), stringify({ projects }))
    // A minute a second: HEAD has settled by the beat after the first look.
    const started = Date.now()
    await alone({
      config: ConfigSchema.parse({ projects }),
      now: () => started + (Date.now() - started) * 60,
    })
    await until(
      'a batch ran at HEAD, with nobody asking',
      async () =>
        (await readRuns(recordsDir(home, 'app', null))).some(
          (run) => run.by === BATCH_BY && run.commit === head && run.state === 'failed',
        ),
      SPAWNING_MS,
    )
    const proposal = `app/red-full-run-${head.slice(0, 7)}`
    await until('one proposal parked', async () =>
      Boolean((await readTaskFile(home, proposal))?.parked),
    )
    // Nothing starts what the orchestrator decides, and there is none here to decide it.
    expect(client.runs()).toEqual([])
    await until('the log says it is for the orchestrator', () =>
      sayings().some(
        (text) =>
          text.startsWith(NOBODY_TO_TELL) &&
          text.includes(`The full checks of app went red at ${head.slice(0, 8)}`),
      ),
    )
  })

  it('folds what was handed over from outside, with nothing drawing the inbox', async () => {
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
    const running = await alone()
    const where = {
      item: 'cli:req-1',
      source: 'cli',
      external_id: 'req-1',
      revision: '1',
      project: 'app',
      requester: 'kim',
      hash: 'sha256:aaa',
      ref: 'req-1.0001.json',
      url: 'https://example.invalid/req-1',
      watch: 'intake.cli',
      schedule: 'intake-cli',
    }
    await client.log.append({ type: 'intake_received', detail: where })
    await client.log.append({
      type: 'intake_accepted',
      task: 'app/refunds',
      detail: {
        ...where,
        grant: 'surfaces.intake.sources.cli',
        mode: 'propose',
        template: 'bug',
        version: 3,
      },
    })
    await until('the inbox folded on the beat', () =>
      (running.intake.facts().intake ?? []).some((row) => row.item === 'cli:req-1'),
    )
    // And the factory floor the away view reads is the same fold.
    await until('the floor rebuilt from it', () =>
      JSON.stringify(running.intake.factory()).includes('cli:req-1'),
    )
  })

  it('listens for a paired phone and tells it when work finishes, with nobody at a screen', async () => {
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
    const port = await freePort()
    await paired(home, port, [])
    // Written before the listener comes up, which is when a window reads them.
    await appendPush(home, {
      kind: 'subscribed',
      device: DEVICE,
      at: new Date().toISOString(),
      endpoint: 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ',
      p256dh: Buffer.alloc(P256DH_BYTES, 4).toString('base64url'),
      auth: Buffer.alloc(AUTH_BYTES, 7).toString('base64url'),
    })
    const pusher = scriptedPusher([])
    // Local midday: the quiet hours are the night's, and a phone told nothing
    // then is the right answer to a different question.
    const midday = new Date()
    midday.setHours(12, 0, 0, 0)
    // The heart's own collector, counted as each look lands.
    let looks = 0
    const own = makeCollector('here')
    onTestFinished(() => own.close())
    const status: StatusCollector = {
      id: own.id,
      collect: async (ask) => {
        const answer = await own.collect(ask)
        looks += 1
        return answer
      },
      close: () => own.close(),
    }
    const running = await alone({
      status,
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: {
          web: {
            enabled: true,
            port,
            install: true,
            push: true,
            push_key: generateVapid().privateKey,
          },
        },
      }),
      pusher: () => pusher,
      now: () => midday.getTime(),
    })
    // The listener came up with the heart: there is no window to have opened it.
    expect(running.away.facts().remote).toEqual({ on: true, devices: 0 })
    // A notification is a transition, so a beat has to have seen the work
    // first, and it has to be a beat of the push half's with the subscription
    // read — which is when the listener is up, and `alone` returns. A look can
    // land while it is still coming up (on Linux, where git is quick, the first
    // one does), and the half remembers nothing of a beat with nothing
    // subscribed. Two looks from here: the first may have been asked before
    // the listener was up, and the second is asked only once the first is in.
    const from = looks
    await until(
      () => `two looks after the listener came up, and ${looks - from} landed`,
      () => looks >= from + 2,
      SPAWNING_MS,
    )
    expect(running.state.panes.some((pane) => pane.task === 'app/refunds')).toBe(true)
    // And it answers the phone what a window would.
    const read = await get(port, '/api/snapshot')
    expect(read.status).toBe(200)
    expect(read.text).toContain('app/refunds')
    await client.markDone('app/refunds', { by: 'you' })
    const done = looks
    await until(
      () =>
        `the phone was told, and ${pusher.sent.length} were sent in ${looks - done} looks since the work was finished`,
      () => pusher.sent.length === 1,
      SPAWNING_MS,
    )
    expect(pusher.sent[0]?.notice.body).toBe('Work has finished')
  })

  it('tells the orchestrator what came due once it runs, and writes down what it said and did', async () => {
    let clock = Date.now()
    const running = await alone({ now: () => clock })
    const schedule = (name: string, ask: string) =>
      running.queueTools().schedule({
        name,
        project: 'app',
        said: `in a moment, ${ask.toLowerCase()}`,
        when: { at: new Date(clock + 60_000).toISOString() },
        ask,
      })

    // Before it runs, what a schedule asks of it is written down — and kept
    // for it, so that one coming up hears it.
    await schedule('Morning brief', 'Say what the agents did.')
    clock += 61_000
    await until('said for an orchestrator that is not running', () =>
      sayings().some(
        (text) => text.startsWith(NOBODY_TO_TELL) && text.includes('Say what the agents did.'),
      ),
    )

    // Now one runs: told after its turn as the real one is, and answering
    // through its events, which is all a window ever reads of it.
    const told: string[] = []
    const listeners: ((event: ThinkerEvent) => void)[] = []
    running.attachThinker({
      ask: async () => '',
      tell: async (text) => {
        told.push(text)
        for (const heard of listeners) {
          heard({ type: 'tool', id: 'call_1', tool: 'tade_queue', input: {} })
          heard({ type: 'tool_done', id: 'call_1', ok: true, text: 'nothing is queued' })
          heard({ type: 'message', text: 'Nothing is waiting on you.' })
          heard({ type: 'idle' })
        }
      },
      onEvent: (listener) => {
        listeners.push(listener)
        return () => {}
      },
    })
    expect(sayings()).toContain('orchestrator ready')
    // Nobody types here to carry what it missed with their next words, so it
    // is told at once, with what came while it was starting as its news.
    await until('told what it missed', () => told.length === 1)
    expect(told[0]).toContain(WHILE_STARTING)
    expect(told[0]).toContain('Say what the agents did.')
    // And what it did and said is the log's, where a window would have drawn it.
    await until('its words in the log', () =>
      said.some((line) => line.kind === 'said' && line.text === 'Nothing is waiting on you.'),
    )
    const lines = said.map(saidLine)
    expect(lines.some((line) => line.endsWith('orchestrator ran tade_queue: done'))).toBe(true)
    expect(lines.some((line) => line.endsWith('orchestrator: Nothing is waiting on you.'))).toBe(
      true,
    )

    // Running, what comes due is told it then and there.
    const before = said.length
    await schedule('Evening brief', 'Say what is left.')
    clock += 61_000
    await until('it was told', () => told.some((text) => text.includes('Say what is left.')))
    expect(told).toHaveLength(2)
    // Running, nothing more is said as being for one that is not.
    expect(said.slice(before).filter((line) => saidLine(line).includes(NOBODY_TO_TELL))).toEqual([])
  })
})

/** One read, as a paired phone makes it. */
function get(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', failed)
    req.end()
  })
}
