import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { depsExtension } from '../src/extension.ts'
import { keyOf, readKey } from '../src/updates.ts'

// The daily watch that keeps dependencies current.
//
// Every registry is answered here and never asked: a test that reached npm
// would be a test of npm, and one that reached it from CI would be a test of
// the weather.

/** What each registry says, by the address it would be asked at. */
function registry(answers: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body)) as { queries: unknown[] }
      return Response.json({ results: body.queries.map(() => ({ vulns: [] })) })
    }
    const answer = answers[url]
    return answer === undefined ? new Response('', { status: 404 }) : Response.json(answer)
  }) as typeof fetch
}

/** A registry that is down: every question answered the same unhelpful way. */
const down: typeof fetch = (async () => new Response('', { status: 503 })) as typeof fetch

const npm = (latest: string) => ({ 'dist-tags': { latest }, versions: {} })

const ANSWERS = {
  // A major: reported, never bumped.
  'https://registry.npmjs.org/react': npm('19.1.0'),
  'https://registry.npmjs.org/left-pad': npm('1.3.1'),
  'https://registry.npmjs.org/lodash': npm('4.17.21'),
  'https://registry.npmjs.org/@types%2fnode': npm('22.1.3'),
  'https://registry.npmjs.org/vitest': npm('4.1.0'),
  'https://pypi.org/pypi/requests/json': {
    info: { version: '2.32.3' },
    releases: { '2.31.0': [], '2.32.3': [] },
  },
}

function project() {
  const repo = mkrepo()
  repo.commit('manifests', {
    'package.json':
      '{\n  "name": "shop",\n  "dependencies": {\n    "react": "^18.2.0",\n    "left-pad": "1.3.0",\n    "lodash": "^4.17.20"\n  },\n  "devDependencies": {\n    "vitest": "~4.0.1",\n    "@types/node": "22.1.0"\n  }\n}\n',
    // The same package named twice: a catalog entry and a pin that follows it.
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\ncatalog:\n  lodash: ^4.17.20\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'api/requirements.txt': 'requests==2.31.0\n',
  })
  return repo
}

/** A project, and a Tade home that says where its agents work. */
function place(workspace: 'worktree' | 'checkout' | null = 'worktree') {
  const repo = project()
  const home = tmp('tade-deps-updates-')
  if (workspace !== null) {
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  shop:\n    root: ${repo.root}\n    workspace: ${workspace}\n`,
      'utf8',
    )
  }
  return { repo, home }
}

async function host(
  root: string,
  home: string,
  fetcher: typeof fetch = registry(ANSWERS),
  settings: Record<string, unknown> = {},
): Promise<ExtensionHost> {
  return ExtensionHost.load({
    builtin: [depsExtension],
    config: {
      extensions: { deps: settings },
      projects: { shop: { root, test_command: 'pnpm test' } },
    },
    home,
    // Not the environment this runs in: `pnpm run` names its own registry there.
    env: {},
    fetch: fetcher,
  })
}

function look(extensions: ExtensionHost, input: Record<string, unknown> = {}) {
  return extensions.look('deps.updates', {
    project: 'shop',
    input,
    since: null,
    turnedOn: '2026-09-01T00:00:00.000Z',
  })
}

/** A schedule of this watch, so what it once found can be read back under its id. */
function schedule(home: string): void {
  writeFileSync(
    join(home, 'schedules.jsonl'),
    `${JSON.stringify({
      op: 'set',
      by: 'you',
      at: '2026-09-01T00:00:00.000Z',
      schedule: {
        id: 'dependency-updates-shop',
        name: 'Dependency updates',
        project: 'shop',
        said: '',
        when: { every: '1d' },
        does: { kind: 'watch', watch: 'deps.updates', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: '2026-09-01T00:00:00.000Z',
      },
    })}\n`,
    'utf8',
  )
}

/** Findings this watch is recorded as having started work on, an hour ago. */
function alreadyBumped(home: string, keys: readonly string[]): void {
  writeFileSync(
    join(home, 'events.jsonl'),
    `${keys
      .map((key, i) =>
        JSON.stringify({
          seq: i + 1,
          ts: new Date(Date.now() - 60 * 60_000).toISOString(),
          type: 'watch_found',
          urgency: 'notable',
          task: `shop/bump-${i}`,
          detail: { schedule: 'dependency-updates-shop', key, title: key },
        }),
      )
      .join('\n')}\n`,
    'utf8',
  )
}

describe('the key a bump is known by', () => {
  it('is each package at the version it moves to, and reads back with a scoped name intact', () => {
    const key = keyOf('patch', [
      { name: 'left-pad', to: '1.3.1' },
      { name: '@types/node', to: '22.1.3' },
    ])
    expect(key).toBe('patch:@types/node@22.1.3,left-pad@1.3.1')
    expect(readKey(key)).toEqual({ shape: 'patch', names: ['@types/node', 'left-pad'] })
    // Written the same way whatever order they came in: the set is the identity.
    expect(
      keyOf('patch', [
        { name: '@types/node', to: '22.1.3' },
        { name: 'left-pad', to: '1.3.1' },
      ]),
    ).toBe(key)
    expect(readKey('minor:vitest@4.1.0')).toEqual({ shape: 'minor', names: ['vitest'] })
    expect(readKey('github.com/acme/api@abc')).toBeNull()
    expect(readKey('patch')).toBeNull()
    expect(readKey('patch:')).toBeNull()
  })
})

describe('looking for what is behind', () => {
  it('batches the patches, gives each minor its own, and names the majors once', async () => {
    const { repo, home } = place()
    const looked = await look(await host(repo.root, home))

    expect(looked.found.map((one) => one.key)).toEqual([
      'patch:@types/node@22.1.3,left-pad@1.3.1,lodash@4.17.21',
      'minor:requests@2.32.3',
      'minor:vitest@4.1.0',
    ])
    expect(looked.found[0]?.title).toBe('bump 3 patch releases (left-pad, lodash and 1 more)')
    expect(looked.found[1]?.title).toBe('bump requests to 2.32.3')

    // One package required in two manifests is one bump, and both are named.
    expect(looked.found[0]?.detail).toContain('- lodash: ^4.17.20 → ^4.17.21 (patch)')
    expect(looked.found[0]?.detail).toContain('pnpm-workspace.yaml')

    // The major rides on the first finding of the look and on no other, and it
    // is there to be reported rather than done.
    expect(looked.found[0]?.detail).toContain('- react → 19.1.0')
    expect(looked.found[0]?.detail).toContain('not this agent’s to bump')
    expect(looked.found[1]?.detail).not.toContain('react')
    expect(looked.found[2]?.detail).not.toContain('react')
    // And nothing was touched by looking.
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('bumps nothing above the level it was turned on with', async () => {
    const { repo, home } = place()
    const looked = await look(await host(repo.root, home), { level: 'patch' })
    expect(looked.found.map((one) => one.key)).toEqual([
      'patch:@types/node@22.1.3,left-pad@1.3.1,lodash@4.17.21',
    ])
  })

  it('finds nothing to do when everything is current, and says so by finding nothing', async () => {
    const { repo, home } = place()
    const current = await host(
      repo.root,
      home,
      registry({
        'https://registry.npmjs.org/react': npm('18.2.0'),
        'https://registry.npmjs.org/left-pad': npm('1.3.0'),
        'https://registry.npmjs.org/lodash': npm('4.17.20'),
        'https://registry.npmjs.org/@types%2fnode': npm('22.1.0'),
        'https://registry.npmjs.org/vitest': npm('4.0.1'),
        'https://pypi.org/pypi/requests/json': {
          info: { version: '2.31.0' },
          releases: { '2.31.0': [] },
        },
      }),
    )
    await expect(look(current)).resolves.toMatchObject({ found: [] })
  })

  it('leaves alone what the settings say to ignore', async () => {
    const { repo, home } = place()
    const looked = await look(
      await host(repo.root, home, registry(ANSWERS), {
        ignore: ['lodash', 'left-pad', 'requests'],
      }),
    )
    expect(looked.found.map((one) => one.key)).toEqual([
      'patch:@types/node@22.1.3',
      'minor:vitest@4.1.0',
    ])
  })
})

describe('when it cannot look', () => {
  it('is not a project that is current when no registry would answer', async () => {
    const { repo, home } = place()
    // One stable sentence, so the window says it when it starts going wrong
    // and not again at every look while it stays wrong.
    await expect(look(await host(repo.root, home, down))).rejects.toThrow(
      'no registry could be asked about the 6 dependencies of shop: its registry answered 503',
    )
  })

  it('reports what it could ask about, and says how much it could not', async () => {
    const { repo, home } = place()
    const partial = await host(
      repo.root,
      home,
      registry({ 'https://registry.npmjs.org/vitest': npm('4.1.0') }),
    )
    const looked = await look(partial)
    expect(looked.found.map((one) => one.key)).toEqual(['minor:vitest@4.1.0'])
    expect(looked.found[0]?.detail).toContain(
      '5 of this project’s dependencies could not be checked at all (not found in its registry)',
    )
  })

  it('refuses a project whose agents share its own checkout, and names both ways out', async () => {
    const { repo, home } = place('checkout')
    await expect(look(await host(repo.root, home))).rejects.toThrow(
      /set projects\.shop\.workspace to worktree, or turn this watch on with in_checkout true/,
    )
    // A home with no config at all is read as the checkout, which is the
    // machine's own default: guessing the other way would let a clock rewrite
    // a tree three other agents are working in.
    const { repo: other, home: bare } = place(null)
    await expect(look(await host(other.root, bare))).rejects.toThrow(/in its own checkout/)
    // And it is a refusal somebody can lift where they mean to.
    const said = await look(await host(repo.root, home), { in_checkout: true })
    expect(said.found.length).toBe(3)
  })

  it('is not a look that went wrong when the folder is no repository', async () => {
    const home = tmp('tade-deps-nogit-')
    const root = tmp('tade-deps-plain-')
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  shop:\n    root: ${root}\n    workspace: worktree\n`,
      'utf8',
    )
    await expect(look(await host(root, home))).rejects.toThrow('is not a git repository')
  })
})

describe('what an agent on a bump is told', () => {
  it('moves them in its own worktree, runs the project’s checks, and commits nothing red', async () => {
    const { repo, home } = place()
    const looked = await look(await host(repo.root, home))
    const batch = looked.found[0]
    if (!batch) throw new Error('nothing was found to bump')
    const agent = await looked.agent(batch)

    expect(agent.title).toBe('bump 3 patch releases')
    expect(agent.prompt).toContain(
      'deps_update with level patch and packages ["@types/node","left-pad","lodash"]',
    )
    expect(agent.prompt).toContain('moves those requirements in your own worktree and nothing else')
    expect(agent.prompt).toContain('leaves ranges and ceilings exactly as somebody wrote them')
    expect(agent.prompt).toContain('Then run `pnpm install`')
    expect(agent.prompt).toContain('checks_run` — never by typing the command in a shell')
    expect(agent.prompt).toContain(
      'If Tade has no checks recorded for this project, run `pnpm test`',
    )
    expect(agent.prompt).toContain('Bump nothing to a new major')
    expect(agent.prompt).toContain('leave that one at the version it was, bump the rest')
    expect(agent.prompt).toContain('Commit only once the checks are green')
    expect(agent.prompt).toContain('put every manifest and lockfile back the way you found it')
    expect(agent.context).toContain('- left-pad: 1.3.0 → 1.3.1 (patch)')
  })

  it('tells one minor apart from a batch of them', async () => {
    const { repo, home } = place()
    const looked = await look(await host(repo.root, home))
    const minor = looked.found.find((one) => one.key === 'minor:vitest@4.1.0')
    if (!minor) throw new Error('no minor release was found')
    const agent = await looked.agent(minor)
    expect(agent.title).toBe('bump vitest')
    expect(agent.prompt).toContain('deps_update with level minor and packages ["vitest"]')
    expect(agent.prompt).not.toContain('leave that one at the version it was')
  })
})

describe('a package it has already tried', () => {
  it('is told about rather than bumped again, and is not in the batch', async () => {
    const { repo, home } = place()
    schedule(home)
    // Two bumps of lodash in the last fortnight, and it is still behind.
    alreadyBumped(home, ['patch:lodash@4.17.21', 'patch:left-pad@1.3.0,lodash@4.17.21'])
    const looked = await look(await host(repo.root, home))

    expect(looked.found.map((one) => one.key)).toEqual([
      // The other patches still go, in one commit: one bad release must not
      // hold up the rest.
      'patch:@types/node@22.1.3,left-pad@1.3.1',
      'minor:requests@2.32.3',
      'minor:vitest@4.1.0',
      'held:lodash@4.17.21',
    ])
    const held = looked.found[3]
    if (!held) throw new Error('lodash was not held')
    expect(held.title).toBe('lodash is still behind 4.17.21 after 2 automatic bumps')
    // Told, and told without a lane: nothing is started on it, and the sentence
    // is what reaches the orchestrator.
    await expect(looked.agent(held)).rejects.toThrow(
      /somebody should move it by hand, or put it in extensions\.deps\.ignore/,
    )
  })

  it('counts only the bumps that started work, and only within the fortnight', async () => {
    const { repo, home } = place()
    schedule(home)
    writeFileSync(
      join(home, 'events.jsonl'),
      `${[
        // Started work, but four weeks ago: a bad week last month is not a
        // reason never to bump a package again.
        {
          seq: 1,
          ts: new Date(Date.now() - 28 * 24 * 60 * 60_000).toISOString(),
          type: 'watch_found',
          urgency: 'notable',
          task: 'shop/bump-old',
          detail: { schedule: 'dependency-updates-shop', key: 'patch:lodash@4.17.21', title: 'x' },
        },
        // Found an hour ago, but nothing was started on it, so nothing was tried.
        {
          seq: 2,
          ts: new Date(Date.now() - 60 * 60_000).toISOString(),
          type: 'watch_found',
          urgency: 'notable',
          detail: { schedule: 'dependency-updates-shop', key: 'patch:lodash@4.17.21', title: 'x' },
        },
      ]
        .map((one) => JSON.stringify(one))
        .join('\n')}\n`,
      'utf8',
    )
    const looked = await look(await host(repo.root, home))
    expect(looked.found[0]?.key).toBe('patch:@types/node@22.1.3,left-pad@1.3.1,lodash@4.17.21')
  })

  it('takes the allowance from the settings', async () => {
    const { repo, home } = place()
    schedule(home)
    alreadyBumped(home, ['patch:lodash@4.17.21'])
    const looked = await look(await host(repo.root, home, registry(ANSWERS), { attempts: 1 }))
    expect(looked.found.map((one) => one.key)).toContain('held:lodash@4.17.21')
  })
})

describe('the bound on one commit', () => {
  it('takes a batch at a time and says how many wait for the next look', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 22 }, (_, i) => [`pkg-${String(i).padStart(2, '0')}`, '1.0.0']),
    )
    const repo = mkrepo()
    repo.commit('manifests', {
      'package.json': `${JSON.stringify({ name: 'shop', dependencies: many }, null, 2)}\n`,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    })
    const home = tmp('tade-deps-many-')
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  shop:\n    root: ${repo.root}\n    workspace: worktree\n`,
      'utf8',
    )
    const looked = await look(
      await host(
        repo.root,
        home,
        registry(
          Object.fromEntries(
            Object.keys(many).map((name) => [`https://registry.npmjs.org/${name}`, npm('1.0.1')]),
          ),
        ),
      ),
    )
    expect(looked.found.length).toBe(1)
    expect(readKey(looked.found[0]?.key ?? '')?.names.length).toBe(20)
    expect(looked.found[0]?.detail).toContain('2 more patch releases wait for the next look')
  })

  it('says to install however the project installs, where no lockfile says how', async () => {
    const repo = mkrepo()
    repo.commit('manifests', { 'api/requirements.txt': 'requests==2.31.0\n' })
    const home = tmp('tade-deps-nolock-')
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  shop:\n    root: ${repo.root}\n    workspace: worktree\n`,
      'utf8',
    )
    const looked = await look(await host(repo.root, home))
    const finding = looked.found[0]
    if (!finding) throw new Error('nothing was found to bump')
    const agent = await looked.agent(finding)
    expect(agent.prompt).toContain('Then install, however this project installs')
  })

  it('lists every major waiting, in one order on every machine', async () => {
    const { repo, home } = place()
    const looked = await look(
      await host(
        repo.root,
        home,
        registry({ ...ANSWERS, 'https://registry.npmjs.org/left-pad': npm('2.0.0') }),
      ),
    )
    expect(looked.found[0]?.detail).toContain('- left-pad → 2.0.0\n- react → 19.1.0')
  })
})
