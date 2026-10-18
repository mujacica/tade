import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Graph, testsReaching, workspaceAt } from '../scripts/related-graph.ts'

// Which tests a change reaches (`scripts/related-graph.ts`): narrower than
// `vitest related` through a package's `index.ts`, and never narrower than
// what a test can actually see. Every case below that says "reaches" is a real
// dependency a narrower graph must still catch.

function repo(files: Record<string, string>): Graph {
  const root = mkdtempSync(join(tmpdir(), 'related-'))
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return new Graph(workspaceAt(root))
}

const pkg = {
  'packages/core/package.json': JSON.stringify({
    name: '@tade/core',
    exports: { '.': './src/index.ts' },
  }),
  'packages/core/src/index.ts':
    "export * from './home.ts'\nexport * from './config.ts'\nexport { b as bee } from './bee.ts'\n",
  'packages/core/src/home.ts':
    "import { join } from 'node:path'\nexport const home = () => join('a', 'b')\n",
  'packages/core/src/config.ts':
    "import { parse } from './parse.ts'\nexport function load() { return parse() }\nexport type Config = { a: 1 }\n",
  'packages/core/src/parse.ts': 'export const parse = () => 1\n',
  'packages/core/src/bee.ts': 'export const b = 2\n',
}

const reaching = (graph: Graph, tests: string[], changed: string) =>
  testsReaching(graph, tests, [changed])

describe('a change reaches the tests that can see it', () => {
  it('through a barrel, only for the names a test takes from it', () => {
    const graph = repo({
      ...pkg,
      'packages/a/test/home.test.ts': "import { home } from '@tade/core'\n",
      'packages/a/test/load.test.ts': "import { load } from '@tade/core'\n",
    })
    const tests = ['packages/a/test/home.test.ts', 'packages/a/test/load.test.ts']
    expect(reaching(graph, tests, 'packages/core/src/home.ts')).toEqual([
      'packages/a/test/home.test.ts',
    ])
    // A real dependency, two files down behind the barrel, is still caught.
    expect(reaching(graph, tests, 'packages/core/src/parse.ts')).toEqual([
      'packages/a/test/load.test.ts',
    ])
    // The barrel itself is every importer's.
    expect(reaching(graph, tests, 'packages/core/src/index.ts')).toEqual(tests)
  })

  it('through a renamed re-export, a namespace and a dynamic import', () => {
    const graph = repo({
      ...pkg,
      'packages/a/test/bee.test.ts': "import { bee } from '@tade/core'\n",
      'packages/a/test/star.test.ts': "import * as core from '@tade/core'\n",
      'packages/a/test/later.test.ts': "const later = () => import('@tade/core')\n",
      'packages/a/test/type.test.ts':
        "import type { Config } from '@tade/core'\nimport { home } from '@tade/core'\n",
    })
    const tests = [
      'packages/a/test/bee.test.ts',
      'packages/a/test/star.test.ts',
      'packages/a/test/later.test.ts',
      'packages/a/test/type.test.ts',
    ]
    expect(reaching(graph, tests, 'packages/core/src/bee.ts')).toEqual(tests.slice(0, 3))
    // A type is gone at run time, so taking one reaches nothing.
    expect(reaching(graph, tests, 'packages/core/src/config.ts')).toEqual(tests.slice(1, 3))
  })

  it('through what runs as a barrel loads it, however little a test took', () => {
    const graph = repo({
      ...pkg,
      'packages/core/src/index.ts': `${pkg['packages/core/src/index.ts']}export * from './registers.ts'\n`,
      'packages/core/src/registers.ts':
        "import { add } from './registry.ts'\nadd('x')\nexport const registered = 1\n",
      'packages/core/src/registry.ts': 'export const add = (_: string) => {}\n',
      'packages/a/test/home.test.ts': "import { home } from '@tade/core'\n",
    })
    expect(
      reaching(graph, ['packages/a/test/home.test.ts'], 'packages/core/src/registry.ts'),
    ).toEqual(['packages/a/test/home.test.ts'])
  })

  it('through a top-level `await` a barrel runs as it loads it', () => {
    const graph = repo({
      ...pkg,
      'packages/core/src/index.ts': `${pkg['packages/core/src/index.ts']}export * from './loaded.ts'\n`,
      'packages/core/src/loaded.ts':
        "import { read } from './reader.ts'\nexport const loaded = await read()\n",
      'packages/core/src/reader.ts': 'export const read = async () => 1\n',
      'packages/a/test/home.test.ts': "import { home } from '@tade/core'\n",
    })
    expect(
      reaching(graph, ['packages/a/test/home.test.ts'], 'packages/core/src/reader.ts'),
    ).toEqual(['packages/a/test/home.test.ts'])
  })

  it('through a file handed to another process, and to a deleted module', () => {
    const graph = repo({
      ...pkg,
      'packages/a/src/bin.ts': "import { load } from '@tade/core'\nload()\n",
      'packages/a/test/spawns.test.ts':
        "const bin = new URL('../src/bin.ts', import.meta.url)\nimport { gone } from '../src/gone.ts'\n",
    })
    const tests = ['packages/a/test/spawns.test.ts']
    expect(reaching(graph, tests, 'packages/core/src/parse.ts')).toEqual(tests)
    expect(reaching(graph, tests, 'packages/a/src/gone.ts')).toEqual(tests)
  })

  it('from a setup file every test runs under, to every test', () => {
    const graph = repo({
      ...pkg,
      'test/setup.ts': "import { home } from '@tade/core'\n",
      'packages/a/test/bee.test.ts': "import { bee } from '@tade/core'\n",
    })
    const tests = ['packages/a/test/bee.test.ts']
    expect(testsReaching(graph, tests, ['packages/core/src/home.ts'], ['test/setup.ts'])).toEqual(
      tests,
    )
  })

  it('in this repository: a test taking one name from `@tade/core` reaches the file behind it, and not all of core', () => {
    const graph = new Graph(workspaceAt(fileURLToPath(new URL('..', import.meta.url))))
    // `domain.test.ts` takes `domainSays` from `@tade/core`, whose barrel
    // re-exports every one of core's files.
    const reached = graph.reach('packages/workbench/test/domain.test.ts')
    expect(reached.has('packages/workbench/src/domain.ts')).toBe(true)
    expect(reached.has('packages/core/src/domain.ts')).toBe(true)
    expect(reached.has('packages/core/src/templates.ts')).toBe(false)
  })
})
