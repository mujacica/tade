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

function look(
  extensions: ExtensionHost,
  input: Record<string, unknown> = {},
  tade: Parameters<ExtensionHost['look']>[1]['tade'] = null,
) {
  return extensions.look('deps.updates', {
    project: 'shop',
    input,
    since: null,
    turnedOn: '2026-09-01T00:00:00.000Z',
    tade,
  })
}

/** An open window with these tasks' agents at work in it, as a watch sees one. */
function windowWith(
  tasks: readonly string[] = [],
): NonNullable<Parameters<ExtensionHost['look']>[1]['tade']> {
  return {
    pid: process.pid,
    lanes: () => [],
    agents: () =>
      tasks.map((task) => ({
        task,
        project: task.split('/')[0] ?? '',
        startedAt: 0,
        turn: 'running' as const,
        did: [],
        ends: [],
      })),
    startAgent: async () => ({ task: '', worktree: '' }),
  }
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

describe('where the work goes', () => {
  it('asks for a tree of its own, whatever the project says about where its agents work', async () => {
    // A project set up the ordinary way — every agent in its own checkout,
    // which is also the machine's default — is looked at exactly like one that
    // gives each agent a worktree, and was refused outright before this.
    for (const where of ['checkout', 'worktree', null] as const) {
      const { repo, home } = place(where)
      const looked = await look(await host(repo.root, home))
      expect(looked.found.map((one) => one.key)).toEqual([
        'patch:@types/node@22.1.3,left-pad@1.3.1,lodash@4.17.21',
        'minor:requests@2.32.3',
        'minor:vitest@4.1.0',
      ])
      const batch = looked.found[0]
      if (!batch) throw new Error('nothing was found to bump')
      const agent = await looked.agent(batch)
      // The one thing that makes it safe where agents share a checkout: this
      // work is not put in the tree they are standing in.
      expect(agent.alone).toBe(true)
      expect(agent.prompt).toContain('in your own worktree and nothing else')
      expect(agent.prompt).not.toContain('every other agent here shares')
      expect(repo.git('status', '--porcelain')).toBe('')
    }
  })

  it('bumps in the shared checkout where somebody asked for that, one at a time', async () => {
    const { repo, home } = place('checkout')
    const looked = await look(await host(repo.root, home), { in_checkout: true }, windowWith())
    // One bump per look, because two agents installing in one tree is two
    // installs racing one lockfile. The minors wait for the next look.
    expect(looked.found.map((one) => one.key)).toEqual([
      'patch:@types/node@22.1.3,left-pad@1.3.1,lodash@4.17.21',
    ])
    // And what it held back is said on the one it kept, rather than being
    // quietly dropped: a watch that looks every day as though one thing were
    // behind is a watch nobody can read.
    expect(looked.found[0]?.detail).toContain(
      '2 other bumps wait for the next look: each is an install in this project’s own checkout',
    )
    // And the majors still ride on it, since it is the first finding of the look.
    expect(looked.found[0]?.detail).toContain('- react → 19.1.0')
    const agent = await looked.agent(looked.found[0] ?? { key: '', title: '' })
    expect(agent.alone).toBeUndefined()
    expect(agent.prompt).toContain('it moves those requirements where you work and nothing else')
    expect(agent.prompt).toContain('shop’s own checkout, which every other agent here shares')
    expect(agent.prompt).toContain('each added by its path — never `git add -A`')
    expect(agent.prompt).toContain('leave it exactly as it is and say so')
  })

  it('says nothing about a project that already gives every agent a tree', async () => {
    // `in_checkout` is about a shared checkout. Where there is none to share,
    // the work goes where it would have gone anyway and nothing is held.
    const { repo, home } = place('worktree')
    const looked = await look(await host(repo.root, home), { in_checkout: true }, windowWith())
    expect(looked.found.length).toBe(3)
    const agent = await looked.agent(looked.found[0] ?? { key: '', title: '' })
    expect(agent.alone).toBe(true)
  })

  it('holds while that checkout has work in it nobody has committed', async () => {
    const { repo, home } = place('checkout')
    writeFileSync(join(repo.root, 'package.json'), '{\n  "name": "shop-mid-edit"\n}\n', 'utf8')
    const looked = await look(await host(repo.root, home), { in_checkout: true }, windowWith())
    expect(looked.found).toEqual([])
    expect(looked.said).toBe(
      'shop’s own checkout has work in it nobody has committed, and a bump there would be mixed into it',
    )
    // Held, not failed: nothing is drawn as trouble and the releases are still
    // there for the next look.
    expect(repo.git('status', '--porcelain')).toContain('package.json')
  })

  it('holds while an agent is at work in it, and where nothing can see who is', async () => {
    const { repo, home } = place('checkout')
    const extensions = await host(repo.root, home)
    const busy = await look(extensions, { in_checkout: true }, windowWith(['shop/refunds']))
    expect(busy.found).toEqual([])
    expect(busy.said).toBe(
      'an agent is at work in shop’s own checkout, and a bump there would rewrite the tree under it',
    )
    // Somebody else's project is somebody else's tree.
    const elsewhere = await look(extensions, { in_checkout: true }, windowWith(['api/refunds']))
    expect(elsewhere.found.length).toBe(1)
    // A look with no window cannot tell, and a look that cannot tell holds.
    const blind = await look(extensions, { in_checkout: true })
    expect(blind.found).toEqual([])
    expect(blind.said).toBe(
      'nothing here can see who is at work in shop’s own checkout, so nothing is bumped in it',
    )
  })

  it('holds where git cannot say whether the checkout is clean', async () => {
    const home = tmp('tade-deps-notrepo-')
    const root = tmp('tade-deps-notgit-')
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  shop:\n    root: ${root}\n    workspace: checkout\n`,
      'utf8',
    )
    const looked = await look(await host(root, home), { in_checkout: true }, windowWith())
    expect(looked.said).toBe(
      'git cannot say whether shop’s own checkout is clean, so nothing is bumped in it',
    )
  })

  it('still reports a package it has tried its allowance of times, one bump or not', async () => {
    const { repo, home } = place('checkout')
    schedule(home)
    alreadyBumped(home, ['patch:lodash@4.17.21', 'patch:left-pad@1.3.0,lodash@4.17.21'])
    const looked = await look(await host(repo.root, home), { in_checkout: true }, windowWith())
    // One bump, and everything that is only *said* — nothing is in anybody's
    // tree to be held back.
    expect(looked.found.map((one) => one.key)).toEqual([
      'patch:@types/node@22.1.3,left-pad@1.3.1',
      'held:lodash@4.17.21',
    ])
  })
})
