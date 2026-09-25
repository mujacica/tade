import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readHooks } from '../src/hooks.ts'
import { readChecks } from '../src/read.ts'

// What a project checks, from what it already says: the hook before a commit,
// then the workflows that run on every change, then the one config key for a
// project that has neither, then nothing — which is `unknown`, and true.

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tade-read-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const GATE = [
  'on: [pull_request]',
  'jobs:',
  '  check:',
  '    steps:',
  '      - name: format',
  '        run: pnpm exec biome ci .',
  '      - name: tests',
  '        run: pnpm exec vitest run',
  '',
].join('\n')

describe('the commit hook', () => {
  it('is one check whose command is the hook', async () => {
    const read = await readHooks(repoWith({ '.githooks/pre-commit': '#!/bin/sh\npnpm lint\n' }))
    expect(read?.checks).toHaveLength(1)
    expect(read?.checks[0]?.id).toBe('pre-commit')
    expect(read?.checks[0]?.run).toBe('sh .githooks/pre-commit')
    expect(read?.checks[0]?.from).toBe('.githooks/pre-commit')
  })

  it('knows the managers people actually use, one at a time', async () => {
    const husky = await readHooks(repoWith({ '.husky/pre-commit': 'pnpm lint\n' }))
    expect(husky?.checks[0]?.run).toBe('sh .husky/pre-commit')
    const framework = await readHooks(repoWith({ '.pre-commit-config.yaml': 'repos: []\n' }))
    expect(framework?.checks[0]?.run).toBe('pre-commit run --all-files')
    const lefthook = await readHooks(repoWith({ 'lefthook.yml': 'pre-commit:\n' }))
    expect(lefthook?.checks[0]?.run).toBe('lefthook run pre-commit')
  })

  it('believes the committed hook over the installed one', async () => {
    // A project with both has pointed `core.hooksPath` at the one it committed,
    // and running the other would be running somebody's dead configuration.
    const read = await readHooks(
      repoWith({ '.githooks/pre-commit': 'a\n', '.git/hooks/pre-commit': 'b\n' }),
    )
    expect(read?.checks).toHaveLength(1)
    expect(read?.checks[0]?.from).toBe('.githooks/pre-commit')
  })

  it('is null where there is none, and where the name is a directory', async () => {
    expect(await readHooks(repoWith({ 'README.md': 'hi\n' }))).toBeNull()
    const odd = repoWith({ 'README.md': 'hi\n' })
    mkdirSync(join(odd, '.githooks', 'pre-commit'), { recursive: true })
    expect(await readHooks(odd)).toBeNull()
  })
})

describe('what a project checks', () => {
  it('is the hook first and then CI, because the cheap gate should fail first', async () => {
    const read = await readChecks({
      name: 'demo',
      root: repoWith({ '.githooks/pre-commit': 'a\n', '.github/workflows/ci.yml': GATE }),
    })
    expect(read.checks.map((check) => check.id)).toEqual(['pre-commit', 'format', 'tests'])
    expect(read.source).toBe('CI and hook')
    expect(read.from).toBe('.githooks/pre-commit and .github/workflows/ci.yml')
  })

  it('says which of the two it found where there is only one', async () => {
    const ci = await readChecks({
      name: 'demo',
      root: repoWith({ '.github/workflows/ci.yml': GATE }),
    })
    expect(ci.source).toBe('CI')
    const hook = await readChecks({
      name: 'demo',
      root: repoWith({ '.githooks/pre-commit': 'a\n' }),
    })
    expect(hook.source).toBe('hook')
  })

  it('gives a CI step named after the hook a name of its own', async () => {
    const read = await readChecks({
      name: 'demo',
      root: repoWith({
        '.githooks/pre-commit': 'a\n',
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: pre-commit',
          '        run: pre-commit run --all-files',
          '',
        ].join('\n'),
      }),
    })
    expect(read.checks.map((check) => check.id)).toEqual(['pre-commit', 'pre-commit-2'])
  })

  it('falls back to the one config key, which is not a file in the repository', async () => {
    const read = await readChecks({
      name: 'demo',
      root: repoWith({ 'README.md': 'hi\n' }),
      test: 'pnpm test',
    })
    expect(read.source).toBe('test command')
    expect(read.checks[0]).toMatchObject({ id: 'tests', run: 'pnpm test', from: 'test_command' })
    expect(read.from).toBeNull()
  })

  it('reads a workflow over the config key, because the workflow is the gate', async () => {
    const read = await readChecks({
      name: 'demo',
      root: repoWith({ '.github/workflows/ci.yml': GATE }),
      test: 'pnpm test',
    })
    expect(read.source).toBe('CI')
  })

  it('says nothing rather than inventing a gate', async () => {
    const read = await readChecks({ name: 'demo', root: repoWith({ 'README.md': 'hi\n' }) })
    expect(read).toEqual({ checks: [], source: 'none', from: null, problems: [] })
  })

  it('keeps its sentences for a project whose CI holds nothing it may run', async () => {
    // Not the same as a project with no CI: this one has a workflow, and what
    // it does is something Tade cannot do. The rollup is `unknown` either way,
    // but only one of them has a reason to give anybody.
    const read = await readChecks({
      name: 'demo',
      root: repoWith({
        '.github/workflows/deploy.yml': "on:\n  push:\n    tags: ['v*']\njobs: {}\n",
      }),
    })
    expect(read.checks).toEqual([])
    expect(read.problems).toHaveLength(1)
    expect(read.source).toBe('CI')
  })
})
