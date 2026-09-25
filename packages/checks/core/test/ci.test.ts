import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gateTrigger, readWorkflows } from '../src/ci.ts'

// Reading what CI already says it checks.
//
// Every case here is about the same question from one side or the other: is
// this the gate every change goes through, or is it something that ships? The
// reading is only safe enough to be the definition because that question is
// answered out of what the file states about itself — so these are the cases
// that would make it answer wrongly, and the direction it is allowed to be
// wrong in is always "claimed less".

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tade-ci-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const GATE = [
  'name: ci',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  'jobs:',
  '  check:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - run: pnpm install --frozen-lockfile',
  '      - name: format',
  '        run: pnpm exec biome ci .',
  '      - name: tests',
  '        run: pnpm exec vitest run',
  '',
].join('\n')

describe('which workflows are a gate', () => {
  it('reads what runs on a pull request or a push to a branch', () => {
    expect(gateTrigger({ pull_request: null })).toEqual({ gate: true })
    expect(gateTrigger({ push: { branches: ['main'] } })).toEqual({ gate: true })
    // A push that says nothing about where is every branch, which is the gate.
    expect(gateTrigger({ push: null })).toEqual({ gate: true })
    expect(gateTrigger(['push', 'pull_request'])).toEqual({ gate: true })
    expect(gateTrigger('pull_request')).toEqual({ gate: true })
  })

  it('leaves a release alone, and says which it was', () => {
    const tag = gateTrigger({ push: { tags: ['v*'] }, workflow_dispatch: null })
    expect(tag).toEqual({
      gate: false,
      because: 'it runs on a tag, which is a release and not a gate',
    })
    expect(gateTrigger({ release: { types: ['published'] } }).gate).toBe(false)
    expect(gateTrigger({ schedule: [{ cron: '0 0 * * *' }] }).gate).toBe(false)
    // A reusable workflow on its own: what calls it decides what it is, and
    // guessing that it is a gate is the one guess that could run a release.
    expect(gateTrigger({ workflow_call: null }).gate).toBe(false)
    expect(gateTrigger({ workflow_dispatch: null }).gate).toBe(false)
  })

  it('reads a file that says nothing about when it runs as not a gate', () => {
    expect(gateTrigger(undefined)).toEqual({
      gate: false,
      because: 'it says nothing about when it runs',
    })
  })
})

describe('reading a gate workflow', () => {
  it('takes the steps that are commands, in order, named by their step names', async () => {
    const read = await readWorkflows(repoWith({ '.github/workflows/ci.yml': GATE }))
    expect(read?.checks.map((check) => check.id)).toEqual(['format', 'tests'])
    expect(read?.checks[0]?.run).toBe('pnpm exec biome ci .')
    expect(read?.from).toEqual(['.github/workflows/ci.yml'])
  })

  it('gives every step the machine to itself, as a CI job does', async () => {
    const read = await readWorkflows(repoWith({ '.github/workflows/ci.yml': GATE }))
    // Steps of a job go one at a time on a runner nothing else is using.
    // Running two of them side by side here would be less faithful, not more.
    expect(read?.checks.every((check) => check.alone)).toBe(true)
  })

  it('names the action and the install rather than making checks of them', async () => {
    const read = await readWorkflows(repoWith({ '.github/workflows/ci.yml': GATE }))
    expect(read?.unread.join('\n')).toContain('actions/checkout@v5')
    expect(read?.unread.join('\n')).toContain('prepares the machine rather than checking the code')
    expect(read?.checks.map((check) => check.run).join(' ')).not.toContain('pnpm install')
  })

  it('reads an install anywhere in a multi-line command as setup', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: tmux',
          '        run: |',
          '          command -v tmux >/dev/null || sudo apt-get install -y tmux',
          '          tmux -V',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks).toEqual([])
    expect(read?.unread.join('\n')).toContain('prepares the machine')
  })

  it('names a whole workflow that ships something, and reads none of it', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': GATE,
        '.github/workflows/release.yml': [
          "on:\n  push:\n    tags: ['v*']",
          'jobs:',
          '  publish:',
          '    steps:',
          '      - name: publish',
          '        run: npm publish',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.id)).toEqual(['format', 'tests'])
    expect(read?.unread.join('\n')).toContain('release.yml was not read')
    expect(read?.from).toEqual(['.github/workflows/ci.yml'])
  })

  it('reads none of a job that deploys or publishes, whatever it is named', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  tests:',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '  deploy:',
          '    environment: production',
          '    steps:',
          '      - name: ship it',
          '        run: ./deploy.sh',
          '  release:',
          '    permissions:',
          '      id-token: write',
          '    steps:',
          '      - name: publish',
          '        run: npm publish',
          '  writes:',
          '    permissions: write-all',
          '    steps:',
          '      - name: tag',
          '        run: git tag v1',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.id)).toEqual(['tests'])
    const said = read?.unread.join('\n') ?? ''
    expect(said).toContain('deploys to an environment')
    expect(said).toContain('asks for id-token: write')
    expect(said).toContain('asks for write-all')
  })

  it('reads a job that only writes to the repository, which every job may', async () => {
    // `contents: write` is a job that pushes a commit back, not one that hands
    // a credential to somebody outside. Refusing it would drop the gate of
    // every project whose workflow says so at the top.
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    permissions:',
          '      contents: write',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.id)).toEqual(['tests'])
  })

  it('keeps a check it cannot run, says why, and leaves it out of the rollup', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  unit:',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '      - name: coverage',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '        run: bash <(curl -s codecov.io) -t ${{ secrets.CODECOV }}',
          '      - name: only-main',
          "        if: github.ref == 'refs/heads/main'",
          '        run: pnpm bench',
          '  integration:',
          '    services:',
          '      db:',
          '        image: postgres',
          '    steps:',
          '      - name: integration',
          '        run: pnpm test:integration',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect([...byId.keys()]).toEqual(['tests', 'coverage', 'only-main', 'integration'])
    // A project with one `${{ secrets.… }}` step would otherwise be unknown
    // for ever: these keep their rows and are out of what a local run means.
    expect(byId.get('tests')?.required).toBe(true)
    expect(byId.get('tests')?.skip).toBeUndefined()
    expect(byId.get('coverage')?.required).toBe(false)
    expect(byId.get('coverage')?.skip).toContain('only the runner knows')
    expect(byId.get('only-main')?.skip).toContain('only CI can answer')
    expect(byId.get('integration')?.skip).toContain('service containers')
  })

  it('reads a step whose env needs a secret as one it cannot run', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: e2e',
          '        env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '          TOKEN: ${{ secrets.TOKEN }}',
          '        run: pnpm e2e',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks[0]?.required).toBe(false)
    expect(read?.checks[0]?.skip).toContain('only the runner knows')
  })

  it('reads a declared timeout, and its own where there is none', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: quick',
          '        timeout-minutes: 3',
          '        run: pnpm lint',
          '      - name: patient',
          '        timeout-minutes: 600',
          '        run: pnpm soak',
          '      - name: unsaid',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.minutes)).toEqual([3, 60, 20])
  })

  it('reads continue-on-error as a check nothing is held on', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: flaky',
          '        continue-on-error: true',
          '        run: pnpm bench',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks[0]?.required).toBe(false)
  })

  it('names a step with no name after what it runs, and never twice the same', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - run: pnpm exec biome ci .',
          '      - run: node scripts/coverage.ts',
          '      - run: pnpm exec biome check .',
          '',
        ].join('\n'),
      }),
    )
    // The program, or the script an interpreter runs — and a second of the same
    // takes a name of its own, because two rows with one id is one row.
    expect(read?.checks.map((check) => check.id)).toEqual(['biome', 'coverage', 'biome-2'])
  })

  it('skips a job that calls another workflow, which is read on its own terms', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  gate:',
          '    uses: ./.github/workflows/reusable.yml',
          '  after:',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.id)).toEqual(['tests'])
    expect(read?.unread.join('\n')).not.toContain('gate')
  })

  it('says a workflow will not parse rather than throwing over it', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': GATE,
        '.github/workflows/broken.yml': 'on: [push]\njobs: [unclosed\n',
      }),
    )
    expect(read?.checks.map((check) => check.id)).toEqual(['format', 'tests'])
    expect(read?.unread.join('\n')).toContain('broken.yml is not readable YAML')
  })

  it('is null where there are no workflows to read at all', async () => {
    expect(await readWorkflows(repoWith({ 'README.md': 'hi\n' }))).toBeNull()
    // A folder with nothing in it is the same answer: nothing said anything.
    const empty = repoWith({ 'README.md': 'hi\n' })
    mkdirSync(join(empty, '.github', 'workflows'), { recursive: true })
    expect(await readWorkflows(empty)).toBeNull()
  })

  it('is a reading with no checks where a workflow held none, and says why', async () => {
    // Not the same answer as having no workflows: this project has CI, and
    // what it does is something Tade cannot run. Silence would read as neither.
    const read = await readWorkflows(
      repoWith({ '.github/workflows/deploy.yml': "on:\n  push:\n    tags: ['v*']\njobs: {}\n" }),
    )
    expect(read?.checks).toEqual([])
    expect(read?.unread).toHaveLength(1)
  })

  it('reads a job with no steps, and a step that is neither a command nor an action', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  nothing: {}',
          '  odd:',
          '    steps:',
          '      - name: says nothing',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.id)).toEqual(['tests'])
  })
})
