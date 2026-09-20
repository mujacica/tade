import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { describeReport, installCommands, planUpdate } from '../src/check.ts'
import { depsExtension } from '../src/extension.ts'
import { readManifest, rewrite } from '../src/manifests.ts'
import { goEscape } from '../src/registries.ts'
import { behind, parseVersion, readRequirement } from '../src/versions.ts'

// Checking and updating dependencies. The registries are answered here, never
// asked: a test that reached npm would be a test of npm.

/** What each registry says, by the address it would be asked at. */
function registry(
  answers: Record<string, unknown>,
  vulnerable: Record<string, string[]> = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body)) as { queries: { package: { name: string } }[] }
      return Response.json({
        results: body.queries.map((query) => ({
          vulns: (vulnerable[query.package.name] ?? []).map((id) => ({ id })),
        })),
      })
    }
    const answer = answers[url]
    return answer === undefined ? new Response('', { status: 404 }) : Response.json(answer)
  }) as typeof fetch
}

const npm = (latest: string, deprecated: Record<string, string> = {}) => ({
  'dist-tags': { latest },
  versions: Object.fromEntries(
    Object.entries(deprecated).map(([version, why]) => [version, { deprecated: why }]),
  ),
})

extensionConformance(() => depsExtension)

describe('reading requirements', () => {
  it('finds each one where it is written, in every kind of manifest', () => {
    const json =
      '{\n  "dependencies": {\n    "react": "^18.2.0",\n    "local": "workspace:*"\n  },\n  "devDependencies": { "vitest": "4.0.1" }\n}\n'
    const deps = readManifest('package.json', json)
    expect(
      deps.map((dep) => [dep.name, dep.spec, dep.group, json.slice(dep.start, dep.end)]),
    ).toEqual([
      ['react', '^18.2.0', 'dependencies', '^18.2.0'],
      ['local', 'workspace:*', 'dependencies', 'workspace:*'],
      ['vitest', '4.0.1', 'devDependencies', '4.0.1'],
    ])

    const catalog =
      'packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n  "@types/node": 22.1.0\n'
    expect(
      readManifest('pnpm-workspace.yaml', catalog).map((dep) => [
        dep.name,
        catalog.slice(dep.start, dep.end),
      ]),
    ).toEqual([
      ['react', '^18.2.0'],
      ['@types/node', '22.1.0'],
    ])

    const requirements =
      'requests==2.31.0\n# a comment\nflask[async] >= 2.0 ; python_version > "3.8"\n-r other.txt\n'
    expect(
      readManifest('requirements.txt', requirements).map((dep) => [dep.name, dep.spec]),
    ).toEqual([
      ['requests', '==2.31.0'],
      ['flask', '>=2.0'],
    ])

    const pyproject =
      '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "rich",\n]\n\n[tool.poetry.dependencies]\npython = "^3.11"\npydantic = "^2.5"\n'
    expect(
      readManifest('pyproject.toml', pyproject).map((dep) => [
        dep.name,
        pyproject.slice(dep.start, dep.end),
      ]),
    ).toEqual([
      ['httpx', '>=0.27'],
      ['pydantic', '^2.5'],
    ])

    const cargo =
      '[dependencies]\nserde = { version = "1.0", features = ["derive"] }\ntokio = "1.35"\n\n[dev-dependencies.insta]\nversion = "1.34"\n'
    expect(
      readManifest('Cargo.toml', cargo).map((dep) => [dep.name, cargo.slice(dep.start, dep.end)]),
    ).toEqual([
      ['serde', '1.0'],
      ['tokio', '1.35'],
      ['insta', '1.34'],
    ])

    const gomod =
      'module example.com/x\n\nrequire github.com/pkg/errors v0.9.1\n\nrequire (\n\tgolang.org/x/text v0.14.0\n\tgithub.com/BurntSushi/toml v1.3.2 // indirect\n)\n'
    expect(
      readManifest('go.mod', gomod).map((dep) => [
        dep.name,
        gomod.slice(dep.start, dep.end),
        dep.group,
      ]),
    ).toEqual([
      ['github.com/pkg/errors', 'v0.9.1', 'require'],
      ['golang.org/x/text', 'v0.14.0', 'require'],
      ['github.com/BurntSushi/toml', 'v1.3.2', 'indirect'],
    ])
  })

  it('moves a version forward keeping its operator and precision, and leaves ranges alone', () => {
    const to = parseVersion('19.1.2')!
    expect(readRequirement('npm', '^18.2.0')?.rewrite?.(to)).toBe('^19.1.2')
    expect(readRequirement('npm', '~18.2')?.rewrite?.(to)).toBe('~19.1')
    expect(readRequirement('pypi', '==2.31.0')?.rewrite?.(to)).toBe('==19.1.2')
    expect(readRequirement('npm', '>=1 <2')?.leftAlone).toBe('a range, left as written')
    expect(readRequirement('npm', '1.x')?.rewrite).toBeNull()
    expect(readRequirement('pypi', '<3')?.leftAlone).toContain('ceiling')
    expect(readRequirement('npm', 'workspace:*')).toBeNull()
    // In Go a new major is a different module, so only its number within a major moves.
    expect(readRequirement('go', 'v1.2.3')?.rewrite?.(parseVersion('v1.4.0')!)).toBe('v1.4.0')
    expect(readRequirement('go', 'v1.2.3')?.rewrite?.(parseVersion('v2.0.0')!)).toBe('v1.2.3')
  })

  it('says how far behind a version is, and never that a pre-release is ahead of its release', () => {
    expect(behind(parseVersion('1.2.3')!, parseVersion('1.2.4')!)).toBe('patch')
    expect(behind(parseVersion('1.2.3')!, parseVersion('1.3.0')!)).toBe('minor')
    expect(behind(parseVersion('1.2.3')!, parseVersion('2.0.0')!)).toBe('major')
    expect(behind(parseVersion('2.0.0')!, parseVersion('2.0.0-rc.1')!)).toBe('current')
  })

  it('changes only the characters of the requirement', () => {
    const text = '{\n  "dependencies": {\n    "react": "^18.2.0"  ,\n    "x": "1.0.0"\n  }\n}\n'
    const [react] = readManifest('package.json', text)
    expect(rewrite(text, [{ start: react!.start, end: react!.end, to: '^19.0.0' }])).toBe(
      text.replace('^18.2.0', '^19.0.0'),
    )
  })

  it('knows how each project installs, and how the proxy spells a module', () => {
    expect(installCommands(['pnpm-lock.yaml', 'package.json', 'go.mod'])).toEqual([
      'pnpm install',
      'go mod tidy',
    ])
    expect(goEscape('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml')
  })
})

describe('checking and updating a project', () => {
  function project() {
    const repo = mkrepo()
    repo.commit('manifests', {
      'package.json':
        '{\n  "name": "shop",\n  "dependencies": {\n    "react": "^18.2.0",\n    "left-pad": "1.3.0"\n  },\n  "devDependencies": {\n    "vitest": "~4.0.1"\n  }\n}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'api/requirements.txt': 'requests==2.31.0\n',
    })
    return repo
  }

  const answers = {
    'https://registry.npmjs.org/react': npm('19.1.0'),
    'https://registry.npmjs.org/left-pad': npm('1.3.0', {
      '1.3.0': 'use String.prototype.padStart',
    }),
    'https://registry.npmjs.org/vitest': npm('4.0.5'),
    'https://pypi.org/pypi/requests/json': {
      info: { version: '3.0.0rc1' },
      releases: { '2.31.0': [], '2.32.3': [], '3.0.0rc1': [] },
    },
  }

  async function host(root: string, fetcher: typeof fetch) {
    return ExtensionHost.load({
      builtin: [depsExtension],
      config: { extensions: {}, projects: { shop: { root, test_command: 'pnpm test' } } },
      home: root,
      // Not the environment this runs in: `pnpm run` names its own registry there.
      env: {},
      fetch: fetcher,
    })
  }

  it('reports what is behind, vulnerable and deprecated, reading only', async () => {
    const repo = project()
    const extensions = await host(
      repo.root,
      registry(answers, { requests: ['GHSA-9wx4-h78v-vm56'] }),
    )
    const answer = await extensions.call(
      'deps_check',
      { project: 'shop' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain(
      '**shop**: 4 dependencies in 2 manifests · 3 behind (1 major, 1 minor, 1 patch) · 1 with known vulnerabilities · 1 deprecated',
    )
    expect(answer.text).toContain('- react ^18.2.0 → 19.1.0 (major)')
    expect(answer.text).toContain(
      '- requests ==2.31.0 → 2.32.3 (minor) · vulnerable: GHSA-9wx4-h78v-vm56',
    )
    expect(answer.text).toContain('deprecated: use String.prototype.padStart')
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('watches for vulnerable dependencies, and says what an agent on one is told', async () => {
    const repo = project()
    const extensions = await host(
      repo.root,
      registry(answers, { requests: ['GHSA-9wx4-h78v-vm56', 'PYSEC-2023-74'] }),
    )
    const looked = await extensions.look('deps.vulnerabilities', {
      project: 'shop',
      input: { level: 'minor' },
      since: null,
      turnedOn: '2026-09-15T08:00:00.000Z',
    })
    expect(looked.found).toEqual([
      {
        key: 'pypi:requests:GHSA-9wx4-h78v-vm56+PYSEC-2023-74',
        title: 'requests ==2.31.0: GHSA-9wx4-h78v-vm56, PYSEC-2023-74',
        detail: expect.stringContaining('https://osv.dev/vulnerability/PYSEC-2023-74'),
        links: [
          {
            title: 'GHSA-9wx4-h78v-vm56',
            url: 'https://osv.dev/vulnerability/GHSA-9wx4-h78v-vm56',
          },
          { title: 'PYSEC-2023-74', url: 'https://osv.dev/vulnerability/PYSEC-2023-74' },
        ],
      },
    ])
    const agent = await looked.agent(looked.found[0]!)
    expect(agent.title).toBe('update requests')
    expect(agent.prompt).toContain('deps_update with packages ["requests"] and level minor')
    expect(agent.prompt).toContain('run `pnpm test`')
    expect(agent.context).toContain(
      'In `api/requirements.txt` (requirements). The newest release is 2.32.3 (minor ahead).',
    )

    // Nothing found because OSV could not be asked is not nothing found.
    const offline = await host(repo.root, registry(answers, {}))
    await expect(
      offline.look('deps.vulnerabilities', {
        project: 'shop',
        input: {},
        since: null,
        turnedOn: '2026-09-15T08:00:00.000Z',
      }),
    ).resolves.toMatchObject({ found: [] })
  })

  it("hands an update to a new agent in its own worktree, and never touches the project's checkout", async () => {
    const repo = project()
    const extensions = await host(repo.root, registry(answers))
    const started: { title: string; prompt: string; context?: string; worktree: string }[] = []
    const worktree = mkrepo()
    worktree.commit('copy', {
      'package.json': readFileSync(join(repo.root, 'package.json'), 'utf8'),
      'api/requirements.txt': 'requests==2.31.0\n',
    })
    const answer = await extensions.call(
      'deps_update',
      { project: 'shop', level: 'minor' },
      {
        caller: { kind: 'orchestrator' },
        tade: {
          pid: process.pid,
          lanes: () => [],
          agents: () => [],
          startAgent: async (request) => {
            await request.prepare?.(worktree.root)
            started.push({ ...request, worktree: worktree.root })
            return { task: 'shop/update-dependencies-minor', worktree: worktree.root }
          },
        },
      },
    )
    expect(answer.text).toContain('Started shop/update-dependencies-minor on 2 updates (0 major)')
    expect(started[0]?.prompt).toContain('`pnpm install`')
    expect(started[0]?.prompt).toContain('`pnpm test`')
    expect(started[0]?.context).toContain('- vitest: ~4.0.1 → ~4.0.5 (patch)')
    // Minor means react's major is left for another day.
    expect(readFileSync(join(worktree.root, 'package.json'), 'utf8')).toContain(
      '"react": "^18.2.0"',
    )
    expect(readFileSync(join(worktree.root, 'package.json'), 'utf8')).toContain(
      '"vitest": "~4.0.5"',
    )
    expect(readFileSync(join(worktree.root, 'api/requirements.txt'), 'utf8')).toBe(
      'requests==2.32.3\n',
    )
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it("updates an agent's own worktree when an agent asks", async () => {
    const repo = project()
    const extensions = await host(repo.root, registry(answers))
    const answer = await extensions.call(
      'deps_update',
      { level: 'major', packages: ['react'] },
      {
        caller: { kind: 'agent', task: 'shop/a', project: 'shop', cwd: repo.root },
      },
    )
    expect(answer.text).toContain('- react: ^18.2.0 → ^19.1.0 (major)')
    expect(readFileSync(join(repo.root, 'package.json'), 'utf8')).toContain('"react": "^19.1.0"')
  })

  it('says a registry could not answer, and still reports the rest', async () => {
    const repo = project()
    const report = await (
      await host(repo.root, registry({ 'https://registry.npmjs.org/react': npm('18.3.1') }))
    ).call('deps_check', { project: 'shop' }, { caller: { kind: 'you' } })
    expect(report.text).toContain('react ^18.2.0 → 18.3.1 (minor)')
    expect(report.text).toContain('Could not check 3:')
    expect(report.text).toContain('left-pad (not found in its registry)')
    expect(
      planUpdate({ manifests: [], findings: [], checkedVulnerabilities: false }, 'major'),
    ).toEqual([])
    expect(
      describeReport('x', { manifests: [], findings: [], checkedVulnerabilities: false }),
    ).toContain('all current')
  })
})
