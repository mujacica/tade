import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@wilco/extensions-core'
import { extensionConformance } from '@wilco/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { nextCursor } from '../src/api.ts'
import { findAccess, readIni } from '../src/auth.ts'
import { issueIdOf, sentryExtension } from '../src/extension.ts'
import { rootCauseText, seriesSummary, traceTree } from '../src/format.ts'

// Sentry, answered here the way sentry.io answers. Nothing reaches the
// network; what is under test is what Wilco asks for and what it makes of the
// answer.

const NOW = Date.parse('2026-09-14T09:00:00Z')

const issue = {
  id: '4411',
  shortId: 'SHOP-1A',
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  culprit: 'src/refunds.ts in refund',
  level: 'error',
  status: 'unresolved',
  count: '124',
  userCount: 17,
  firstSeen: '2026-09-13T21:00:00Z',
  lastSeen: '2026-09-14T08:30:00Z',
  permalink: 'https://acme.sentry.io/issues/4411/',
  project: { id: '7', slug: 'shop-api' },
}

const event = {
  id: 'e1',
  title: issue.title,
  tags: [
    { key: 'environment', value: 'production' },
    { key: 'browser', value: 'Chrome 131' },
  ],
  release: { version: 'shop@1.4.2' },
  contexts: { trace: { trace_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } },
  entries: [
    {
      type: 'exception',
      data: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'id')",
            stacktrace: {
              frames: [
                {
                  filename: 'node:internal/process',
                  function: 'processTicks',
                  lineNo: 1,
                  inApp: false,
                },
                {
                  filename: 'src/refunds.ts',
                  function: 'refund',
                  lineNo: 42,
                  colNo: 18,
                  inApp: true,
                  context: [
                    [41, '  const order = await orders.find(id)'],
                    [42, '  return charge(order.id)'],
                  ],
                },
                {
                  filename: 'node_modules/stripe/lib/charge.js',
                  function: 'charge',
                  lineNo: 9,
                  inApp: false,
                },
              ],
            },
          },
        ],
      },
    },
    { type: 'request', data: { method: 'POST', url: 'https://shop.example/api/refunds' } },
    {
      type: 'breadcrumbs',
      data: {
        values: [
          {
            timestamp: '2026-09-14T08:29:58Z',
            category: 'http',
            data: { method: 'GET', url: '/api/orders/9', status_code: 404 },
          },
          {
            timestamp: '2026-09-14T08:29:59Z',
            category: 'console',
            level: 'warning',
            message: 'order 9 not found',
          },
        ],
      },
    },
  ],
}

/** A Sentry that answers by path, records what it was asked, and lives in one region. */
function sentry(overrides: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
  const asked: { method: string; url: URL; body?: string }[] = []
  const routes: Record<string, (url: URL, init?: RequestInit) => Response> = {
    'GET https://sentry.io/api/0/organizations/acme/': () =>
      Response.json({ slug: 'acme', links: { regionUrl: 'https://us.sentry.io' } }),
    'GET https://us.sentry.io/api/0/projects/acme/shop-api/': () =>
      Response.json({ id: '7', slug: 'shop-api' }),
    'GET https://us.sentry.io/api/0/organizations/acme/issues/': () =>
      new Response(JSON.stringify([issue]), {
        headers: { link: '<x>; rel="next"; results="false"; cursor="0:25:0"' },
      }),
    'GET https://us.sentry.io/api/0/organizations/acme/issues/SHOP-1A/': () => Response.json(issue),
    'GET https://us.sentry.io/api/0/organizations/acme/issues/4411/events/recommended/': () =>
      Response.json(event),
    'PUT https://us.sentry.io/api/0/organizations/acme/issues/4411/': (_url, init) =>
      Response.json({ ...issue, ...JSON.parse(String(init?.body)) }),
    'GET https://us.sentry.io/api/0/organizations/acme/events/': () =>
      Response.json({
        data: [
          {
            timestamp: '2026-09-14T08:29:59Z',
            severity: 'error',
            message: 'refund failed | order 9',
            trace: 'a1b2',
            project: 'shop-api',
          },
        ],
      }),
    ...overrides,
  }
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    asked.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) })
    const route = routes[`${method} ${url.origin}${url.pathname}`]
    return route
      ? route(url, init)
      : Response.json({ detail: 'The requested resource does not exist' }, { status: 404 })
  }) as typeof fetch
  return { fetcher, asked }
}

const env = { SENTRY_AUTH_TOKEN: 'sntrys_test', SENTRY_ORG: 'acme' }
const settings = { projects: { shop: 'shop-api' } }

async function host(fetcher: typeof fetch, extra: Record<string, unknown> = {}) {
  return ExtensionHost.load({
    builtin: [sentryExtension],
    config: {
      extensions: { sentry: { ...settings, ...extra } },
      projects: { shop: { root: '/src/shop' } },
    },
    home: '/home',
    env,
    fetch: fetcher,
    now: () => NOW,
  })
}

extensionConformance(() => sentryExtension, { env, settings })

describe('finding credentials', () => {
  it('reads sentry-cli’s own file, nearest first, and never needs Wilco’s config', () => {
    const home = tmp('wilco-sentry-home-')
    const project = join(home, 'src', 'shop')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(home, '.sentryclirc'), '[auth]\ntoken = from-home\n[defaults]\norg = acme\n')
    writeFileSync(
      join(project, '.sentryclirc'),
      '[defaults]\nurl = https://sentry.acme.internal/\n',
    )
    expect(findAccess({ settings: {}, env: { HOME: home }, folders: [project], now: NOW })).toEqual(
      {
        token: 'from-home',
        org: 'acme',
        url: 'https://sentry.acme.internal',
        from: join(home, '.sentryclirc'),
      },
    )
    expect(readIni('[a]\nb = c = d\n; comment\n')).toEqual({ 'a.b': 'c = d' })
  })

  it('says exactly what is missing', () => {
    expect(findAccess({ settings: {}, env: {}, folders: [], now: NOW })).toMatchObject({
      problem: expect.stringContaining('$SENTRY_AUTH_TOKEN'),
    })
    expect(
      findAccess({ settings: {}, env: { SENTRY_AUTH_TOKEN: 't' }, folders: [], now: NOW }),
    ).toMatchObject({
      problem: expect.stringContaining('organization'),
    })
    expect(
      findAccess({
        settings: { token_env: 'ACME_SENTRY' },
        env: { SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'a' },
        folders: [],
        now: NOW,
      }),
    ).toMatchObject({ problem: expect.stringContaining('$ACME_SENTRY') })
  })
})

describe('reading Sentry', () => {
  it("lists a project's issues from its own region, by the project's id", async () => {
    const { fetcher, asked } = sentry()
    const answer = await (await host(fetcher)).call(
      'sentry_issues',
      { project: 'shop', sort: 'new' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain('1 issue in shop-api matching `is:unresolved`')
    expect(answer.text).toContain(
      "- **SHOP-1A** TypeError: Cannot read properties of undefined (reading 'id')",
    )
    expect(answer.text).toContain(
      'error · 124 events · 17 users · first 12h ago · last 30m ago · in src/refunds.ts in refund',
    )
    expect(answer.text).toContain('https://acme.sentry.io/issues/4411/')
    const list = asked.find((one) => one.url.pathname.endsWith('/issues/'))
    expect(list?.url.host).toBe('us.sentry.io')
    expect(list?.url.searchParams.getAll('project')).toEqual(['7'])
    expect(list?.url.searchParams.get('sort')).toBe('new')
    expect(list?.url.searchParams.getAll('collapse')).toEqual(['filtered', 'unhandled'])
  })

  it('writes an issue out so it can be fixed from: the frame that matters, what came before, the trace', async () => {
    const { fetcher } = sentry()
    const answer = await (await host(fetcher)).call(
      'sentry_issue',
      { issue: 'https://acme.sentry.io/issues/shop-1a/' },
      { caller: { kind: 'agent', task: 'shop/fix', project: 'shop', cwd: '/w' } },
    )
    expect(answer.text).toContain('# SHOP-1A: TypeError')
    expect(answer.text).toContain('- Seen 124 times by 17 users')
    expect(answer.text).toContain('- Release: shop@1.4.2')
    expect(answer.text).toContain('- Environment: production')
    expect(answer.text).toContain('## Most relevant frame\n\nsrc/refunds.ts:42:18 in refund')
    expect(answer.text).toContain('> 42 |   return charge(order.id)')
    expect(answer.text).toContain('(library) node_modules/stripe/lib/charge.js:9 in charge')
    expect(answer.text).toContain('POST https://shop.example/api/refunds')
    expect(answer.text).toContain('- 08:29:58 http: GET /api/orders/9 404')
    expect(answer.text).toContain('browser=Chrome 131')
    expect(answer.text).toContain(
      'https://acme.sentry.io/explore/traces/trace/a1b2c3d4e5f60718293a4b5c6d7e8f90/',
    )
  })

  it('reads logs, spans and metrics as a table', async () => {
    const { fetcher, asked } = sentry()
    const answer = await (await host(fetcher)).call(
      'sentry_events',
      { dataset: 'logs', query: 'trace:a1b2' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain('| timestamp | severity | message | trace | project |')
    expect(answer.text).toContain('refund failed \\| order 9')
    const query = asked.find((one) => one.url.pathname.endsWith('/events/'))?.url.searchParams
    expect(query?.get('dataset')).toBe('logs')
    expect(query?.get('query')).toBe('trace:a1b2')
  })

  it('says why Sentry refused, in words that say what to do', async () => {
    const { fetcher } = sentry({
      'GET https://sentry.io/api/0/organizations/acme/': () =>
        Response.json({ detail: 'Invalid token' }, { status: 401 }),
    })
    await expect(
      (await host(fetcher)).call(
        'sentry_issues',
        { project: 'shop' },
        { caller: { kind: 'orchestrator' } },
      ),
    ).rejects.toThrow('Sentry did not accept the token from $SENTRY_AUTH_TOKEN (401)')
  })

  it('makes short ids on screen open the issue, and knows an id however it was said', async () => {
    const { fetcher } = sentry()
    const [linker] = (await host(fetcher)).linkers()
    expect(new RegExp(linker!.pattern).exec('fixed SHOP-API-1A today')?.[0]).toBe('SHOP-API-1A')
    expect(linker!.url).toBe('https://acme.sentry.io/issues/?query=$&')
    expect(issueIdOf(' shop-1a ')).toBe('SHOP-1A')
    expect(issueIdOf('https://acme.sentry.io/issues/4411/?project=7')).toBe('4411')
  })
})

describe('acting on Sentry', () => {
  it('hands a fix to an agent with everything Sentry knows in its context', async () => {
    const { fetcher } = sentry()
    const started: Parameters<
      NonNullable<Parameters<ExtensionHost['call']>[2]['wilco']>['startAgent']
    >[0][] = []
    const answer = await (await host(fetcher)).call(
      'sentry_fix',
      { issue: 'SHOP-1A', note: 'probably the order lookup' },
      {
        caller: { kind: 'orchestrator' },
        wilco: {
          pid: process.pid,
          lanes: () => [],
          startAgent: async (request) => {
            started.push(request)
            return { task: 'shop/fix-shop-1a', worktree: '/w' }
          },
        },
      },
    )
    expect(answer.text).toContain('Started shop/fix-shop-1a on SHOP-1A')
    expect(started[0]).toMatchObject({ project: 'shop', title: 'fix SHOP-1A' })
    expect(started[0]?.prompt).toContain('"Fixes SHOP-1A"')
    expect(started[0]?.context).toContain('> probably the order lookup')
    expect(started[0]?.context).toContain('## Most relevant frame')
    expect(started[0]?.links).toEqual([
      { title: 'SHOP-1A', url: 'https://acme.sentry.io/issues/4411/' },
      {
        title: 'trace a1b2c3d4',
        url: 'https://acme.sentry.io/explore/traces/trace/a1b2c3d4e5f60718293a4b5c6d7e8f90/',
      },
    ])
  })

  it('changes an issue only from the orchestrator, and says what it became', async () => {
    const { fetcher, asked } = sentry()
    const extensions = await host(fetcher)
    const answer = await extensions.call(
      'sentry_update_issue',
      { issue: 'SHOP-1A', status: 'resolved' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toBe('SHOP-1A is now resolved.')
    expect(asked.find((one) => one.method === 'PUT')?.body).toBe('{"status":"resolved"}')
    await expect(
      extensions.call(
        'sentry_update_issue',
        { issue: 'SHOP-1A', status: 'resolved' },
        { caller: { kind: 'agent', task: 'shop/a', project: 'shop', cwd: '/w' } },
      ),
    ).rejects.toThrow('not offered to agents')
  })

  it('puts new issues in the brief, with what to ask about them', async () => {
    const { fetcher } = sentry()
    expect(await (await host(fetcher)).brief()).toEqual({
      items: [
        {
          said: 'Sentry has 1 new issue in shop',
          ask: 'Look at the new Sentry issues in shop and tell me which are worth fixing first, and why',
          links: [
            {
              title: 'new issues in shop',
              url: 'https://acme.sentry.io/issues/?query=is%3Aunresolved%20firstSeen%3A-24h',
            },
          ],
        },
      ],
      problems: [],
    })
    expect(await (await host(fetcher, { brief: false })).brief()).toEqual({
      items: [],
      problems: [],
    })
  })
})

describe('watching Sentry for new errors', () => {
  it('looks for issues first seen since it last looked, and briefs an agent from what Sentry knows', async () => {
    const { fetcher, asked } = sentry({
      'GET https://us.sentry.io/api/0/organizations/acme/issues/4411/': () => Response.json(issue),
    })
    const extensions = await host(fetcher)
    const first = await extensions.look('sentry.new-errors', {
      project: 'shop',
      input: { query: 'level:error' },
      since: null,
      turnedOn: '2026-09-14T06:00:00.000Z',
    })
    const listed = asked.find((one) => one.url.pathname.endsWith('/issues/'))
    // Nothing already there when it was turned on is new.
    expect(listed?.url.searchParams.get('query')).toBe(
      'is:unresolved level:error firstSeen:>=2026-09-14T06:00:00.000Z',
    )
    expect(listed?.url.searchParams.get('sort')).toBe('new')
    expect(listed?.url.searchParams.getAll('project')).toEqual(['7'])
    expect(first.found).toEqual([
      {
        key: '4411',
        title: `SHOP-1A: ${issue.title}`,
        links: [{ title: 'SHOP-1A', url: 'https://acme.sentry.io/issues/4411/' }],
      },
    ])
    // The next look starts a little before this one: Sentry takes a moment to take an event in.
    expect(first.since).toBe('2026-09-14T08:50:00.000Z')

    // Only what work starts on is fetched in full.
    expect(asked.some((one) => one.url.pathname.includes('/events/recommended/'))).toBe(false)
    const agent = await first.agent(first.found[0]!)
    expect(agent).toMatchObject({ title: 'fix SHOP-1A' })
    expect(agent.prompt).toContain('"Fixes SHOP-1A"')
    expect(agent.context).toContain('## Most relevant frame')
    expect(agent.links?.[0]).toEqual({
      title: 'SHOP-1A',
      url: 'https://acme.sentry.io/issues/4411/',
    })

    // A later look starts where the last one left off.
    asked.length = 0
    await extensions.look('sentry.new-errors', {
      project: 'shop',
      input: {},
      since: first.since,
      turnedOn: '2026-09-14T06:00:00.000Z',
    })
    expect(
      asked.find((one) => one.url.pathname.endsWith('/issues/'))?.url.searchParams.get('query'),
    ).toBe('is:unresolved firstSeen:>=2026-09-14T08:50:00.000Z')
  })

  it('says why it cannot look, rather than finding nothing', async () => {
    const { fetcher } = sentry({
      'GET https://us.sentry.io/api/0/organizations/acme/issues/': () =>
        Response.json({ detail: 'Invalid token' }, { status: 401 }),
    })
    await expect(
      (await host(fetcher)).look('sentry.new-errors', {
        project: 'shop',
        input: {},
        since: null,
        turnedOn: '2026-09-14T06:00:00.000Z',
      }),
    ).rejects.toThrow('did not accept the token')
  })
})

describe('setting Sentry up', () => {
  it('says where the token is, and offers the organizations it can see', async () => {
    const { fetcher } = sentry({
      'GET https://sentry.io/api/0/organizations/': () =>
        Response.json([{ slug: 'acme' }, { slug: 'globex' }]),
    })
    const loaded = await ExtensionHost.load({
      builtin: [sentryExtension],
      config: { extensions: { sentry: {} }, projects: { shop: { root: '/src/shop' } } },
      home: '/home',
      env: { SENTRY_AUTH_TOKEN: 'sntrys_test' },
      fetch: fetcher,
      now: () => NOW,
    })
    expect(loaded.list()[0]).toMatchObject({ state: 'needs setup' })
    const setup = loaded.setupOf('sentry')
    expect(setup?.guide[0]).toContain('found in $SENTRY_AUTH_TOKEN')
    expect(setup?.fields.map((field) => field.key)).toEqual(['org', 'projects', 'url', 'brief'])
    expect(await loaded.choices('sentry', 'org')).toEqual(['acme', 'globex'])
    await loaded.reconfigure({ sentry: { org: 'acme' } })
    expect(loaded.list()[0]).toMatchObject({ state: 'ready' })
  })
})

describe('writing Sentry out', () => {
  it('draws a trace as a tree with durations and errors', () => {
    const text = traceTree(
      'abc',
      [
        {
          op: 'http.server',
          transaction: 'POST /api/refunds',
          start_timestamp: 1,
          end_timestamp: 1.25,
          project_slug: 'shop-api',
          children: [
            { op: 'db', description: 'SELECT * FROM orders', duration: 180, errors: [{}] },
          ],
        },
      ],
      'https://acme.sentry.io/explore/traces/trace/abc/',
    )
    expect(text).toContain('- http.server POST /api/refunds — 250ms [shop-api]')
    expect(text).toContain('  - db SELECT * FROM orders — 180ms · 1 error')
    expect(traceTree('abc', [], '')).toContain('No spans were found')
  })

  it('sums a series up, and reads Seer in either shape it answers in', () => {
    expect(
      seriesSummary('p95(span.duration)', [
        { at: Date.parse('2026-09-14T06:00:00Z'), value: 120 },
        { at: Date.parse('2026-09-14T07:00:00Z'), value: 480 },
        { at: Date.parse('2026-09-14T08:00:00Z'), value: 130 },
      ]),
    ).toBe('p95(span.duration): now 130, peak 480 at 2026-09-14 07:00 UTC, low 120\n▁█▁')
    expect(
      rootCauseText({
        status: 'completed',
        blocks: [
          {
            artifacts: [
              { key: 'root_cause', data: 'orders.find returns undefined for deleted orders' },
            ],
          },
        ],
      }),
    ).toContain('## root cause\n\norders.find returns undefined for deleted orders')
    expect(
      rootCauseText({
        status: 'COMPLETED',
        steps: [{ causes: [{ title: 'Deleted orders', description: 'find() returns undefined' }] }],
      }),
    ).toContain('## Deleted orders')
    expect(rootCauseText(null)).toBe('Seer has not looked at this issue yet.')
    expect(
      nextCursor(
        '<a>; rel="previous"; results="false"; cursor="0:0:1", <b>; rel="next"; results="true"; cursor="0:25:0"',
      ),
    ).toBe('0:25:0')
  })
})
