import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventOf, gateTrigger, holdsOn, readWorkflows } from '../src/ci.ts'

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

  it('reads downloading a browser as setup, and the browser tests as a check', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  e2e:',
          '    steps:',
          '      - run: pnpm exec playwright install --with-deps chromium',
          '      - run: pnpm exec playwright test',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.run)).toEqual(['pnpm exec playwright test'])
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

  it('reads every step of a job whose env needs a secret as one it cannot run', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  calibrate:',
          '    env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '      TOKEN: ${{ secrets.TOKEN }}',
          '    steps:',
          '      - name: calibrate',
          '        run: pnpm calibrate',
          '  check:',
          '    env:',
          '      CI: true',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect(byId.get('calibrate')?.required).toBe(false)
    expect(byId.get('calibrate')?.skip).toContain('only the runner knows')
    expect(byId.get('tests')?.required).toBe(true)
    expect(byId.get('tests')?.skip).toBeUndefined()
  })

  it('reads every step of a workflow whose env needs a secret as one it cannot run', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/secret.yml': [
          'on: [pull_request]',
          'env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '  TOKEN: ${{ secrets.TOKEN }}',
          'jobs:',
          '  calibrate:',
          '    steps:',
          '      - name: calibrate',
          '        run: pnpm calibrate',
          '',
        ].join('\n'),
        '.github/workflows/plain.yml': [
          'on: [pull_request]',
          'env:',
          '  CI: true',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect(byId.get('calibrate')?.required).toBe(false)
    expect(byId.get('calibrate')?.skip).toContain('only the runner knows')
    expect(byId.get('tests')?.required).toBe(true)
    expect(byId.get('tests')?.skip).toBeUndefined()
  })

  it('reads a step whose env only says which row of the matrix it is as the check it is', async () => {
    // Tade's own suite is sharded this way: the job's env says which shard,
    // and the step run here, with no row of the matrix, is the whole suite.
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  tests:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '    runs-on: ${{ matrix.os }}',
          '    strategy:',
          '      matrix:',
          '        os: [ubuntu-latest, macos-latest]',
          '        shard: [1, 2, 3, 4]',
          '        include:',
          '          - os: ubuntu-latest',
          '            label: linux',
          '    env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '      VITEST_SHARD: ${{ matrix.shard }}/4',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '      LABEL: ${{ matrix.label }}-${{ matrix.os }}',
          '    steps:',
          '      - name: tests',
          '        run: node scripts/coverage.ts',
          '      - name: by label',
          '        env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '          ROW: ${{ matrix.os }}',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    // One check, not eight: a matrix is run once, here.
    expect(read?.checks.map((check) => check.id)).toEqual(['tests', 'by-label'])
    for (const check of read?.checks ?? []) {
      expect(check.required).toBe(true)
      expect(check.skip).toBeUndefined()
    }
  })

  it('leaves a matrix env to the runner where it is anything more than a row of the matrix', async () => {
    // `${{ … }}` spelled out of pieces, so no line here reads as a template.
    const gh = (expression: string): string => `$${'{{'} ${expression} }}`
    const cases: [label: string, env: string, run: string][] = [
      // A command that names the variable reads the row's value itself.
      ['named', `SHARD: ${gh('matrix.shard')}/4`, 'vitest --shard=$SHARD'],
      ['braced', `SHARD: ${gh('matrix.shard')}`, `vitest --shard=$${'{'}SHARD}/4`],
      // A key the matrix does not state.
      ['missing key', `NODE: ${gh('matrix.node')}`, 'pnpm test'],
      // The matrix value inside an expression, or beside a secret.
      ['expression', `SHARD: ${gh("matrix.shard == 1 && 'a' || 'b'")}`, 'pnpm test'],
      ['beside a secret', `KEY: ${gh('matrix.shard')}-${gh('secrets.KEY')}`, 'pnpm test'],
    ]
    for (const [label, env, run] of cases) {
      const read = await readWorkflows(
        repoWith({
          '.github/workflows/ci.yml': [
            'on: [pull_request]',
            'jobs:',
            '  tests:',
            '    strategy:',
            '      matrix:',
            '        shard: [1, 2, 3, 4]',
            '    env:',
            `      ${env}`,
            '    steps:',
            '      - name: tests',
            `        run: ${run}`,
            '',
          ].join('\n'),
        }),
      )
      expect(read?.checks[0]?.skip, label).toContain('only the runner knows')
      expect(read?.checks[0]?.required, label).toBe(false)
    }
    // A matrix that is itself an expression states no keys at all.
    const computed = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  tests:',
          '    strategy:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}',
          '    env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '      SHARD: ${{ matrix.shard }}',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(computed?.checks[0]?.skip).toContain('only the runner knows')
    // And no workflow-level env has a matrix to answer from.
    const top = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'env:',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '  SHARD: ${{ matrix.shard }}',
          'jobs:',
          '  tests:',
          '    strategy:',
          '      matrix:',
          '        shard: [1, 2]',
          '    steps:',
          '      - name: tests',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(top?.checks[0]?.skip).toContain('only the runner knows')
  })

  it('skips every step after an artifact is downloaded, since it reads what another job made', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  coverage:',
          '    needs: tests',
          '    steps:',
          '      - uses: actions/checkout@v5',
          '      - name: before',
          '        run: pnpm lint',
          '      - uses: actions/download-artifact@v4',
          '        with:',
          '          path: .vitest-reports',
          '      - name: merge',
          '        run: node scripts/coverage.ts --merge .vitest-reports',
          '      - name: after',
          '        run: pnpm report',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect(byId.get('before')?.skip).toBeUndefined()
    expect(byId.get('before')?.required).toBe(true)
    for (const id of ['merge', 'after']) {
      expect(byId.get(id)?.skip, id).toBe(
        'it reads what the action actions/download-artifact@v4 brought from another job',
      )
      expect(byId.get(id)?.required, id).toBe(false)
    }
    expect(read?.unread).toContain(
      '.github/workflows/ci.yml › coverage is the action actions/download-artifact@v4, which only the runner can run',
    )
  })

  it('runs a step in the folder it says, and skips one whose folder is not here to run in', async () => {
    const read = await readWorkflows(
      repoWith({
        'site/package.json': '{}\n',
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - uses: actions/checkout@v5',
          '      - name: site',
          '        run: pnpm test',
          '        working-directory: ./site/',
          '      - name: root',
          '        run: pnpm lint',
          '        working-directory: .',
          '      - uses: actions/checkout@v5',
          '        with:',
          '          repository: someone/game',
          '          path: .ci/game',
          '      - name: toolchain',
          '        run: rustup toolchain install',
          '        working-directory: .ci/game',
          '      - name: botctl',
          '        run: cargo build --bin botctl',
          '        working-directory: .ci/game/server',
          '      - name: gone',
          '        run: make',
          '        working-directory: native',
          '      - name: away',
          '        run: make',
          '        working-directory: ../elsewhere',
          '      - name: told',
          '        run: make',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          '        working-directory: ${{ matrix.dir }}',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect(byId.get('site')).toMatchObject({ cwd: 'site', required: true })
    expect(byId.get('site')?.skip).toBeUndefined()
    expect(byId.get('root')?.cwd).toBeUndefined()
    expect(byId.get('root')?.skip).toBeUndefined()
    // A folder a checkout action makes is the runner's, and a run at the root
    // in its place is a red light about the wrong folder.
    expect(byId.get('toolchain')).toMatchObject({
      required: false,
      skip: 'it runs in .ci/game, which the action actions/checkout@v5 makes',
    })
    expect(byId.get('botctl')).toMatchObject({
      required: false,
      skip: 'it runs in .ci/game/server, which the action actions/checkout@v5 makes',
    })
    expect(byId.get('gone')).toMatchObject({
      required: false,
      skip: 'it runs in native, which is not in this checkout',
    })
    expect(byId.get('away')).toMatchObject({
      required: false,
      skip: 'it runs in ../elsewhere, which is outside this checkout',
    })
    expect(byId.get('told')?.skip).toContain('only the runner knows')
    // Turned on anyway (`run_here`), one still runs where CI says, never at the root.
    expect(byId.get('botctl')?.cwd).toBe('.ci/game/server')
    expect(byId.get('away')?.cwd).toBeUndefined()
    expect(byId.get('told')?.cwd).toBeUndefined()
  })

  it("reads a job's or the workflow's default folder, and lets a step say its own", async () => {
    const read = await readWorkflows(
      repoWith({
        'web/package.json': '{}\n',
        'api/go.mod': 'module api\n',
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'defaults:',
          '  run:',
          '    working-directory: web',
          'jobs:',
          '  web:',
          '    steps:',
          '      - name: web',
          '        run: pnpm test',
          '  api:',
          '    defaults:',
          '      run:',
          '        working-directory: api',
          '    steps:',
          '      - name: api',
          '        run: go test ./...',
          '      - name: docs',
          '        run: make docs',
          '        working-directory: docs',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect(byId.get('web')?.cwd).toBe('web')
    expect(byId.get('api')?.cwd).toBe('api')
    expect(byId.get('docs')?.skip).toBe('it runs in docs, which is not in this checkout')
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

  it("reads a job's timeout for the steps that say none of their own", async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    timeout-minutes: 15',
          '    steps:',
          '      - name: quick',
          '        timeout-minutes: 3',
          '        run: pnpm lint',
          '      - name: unsaid',
          '        run: pnpm test',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => check.minutes)).toEqual([3, 15])
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

// A run here stands for a change, so an `if:` that asks only which event this
// is has an answer here; every other `if:` is still CI's alone.
describe('a condition on which event this is', () => {
  // Shaped like slopmmelier's, which had every check skipped before this.
  const NIGHTLY = [
    'name: ci',
    'on:',
    '  push:',
    '  pull_request:',
    '  schedule:',
    "    - cron: '17 3 * * *'",
    'permissions:',
    '  contents: read',
    'jobs:',
    '  check:',
    "    if: github.event_name != 'schedule'",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - uses: oven-sh/setup-bun@v2',
    '      - run: bun install --frozen-lockfile',
    '      - run: bun run lint',
    '      - run: bun run typecheck',
    '      - run: bun run test',
    '  calibrate:',
    "    if: github.event_name == 'schedule'",
    '    runs-on: ubuntu-latest',
    '    env:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
    '      KEY: ${{ secrets.KEY }}',
    '    steps:',
    "      - if: env.KEY != ''",
    '        uses: actions/checkout@v5',
    "      - if: env.KEY != ''",
    '        working-directory: packages/rules',
    '        run: bun run calibrate --max-usd 0.05',
    '  report:',
    '    needs: [calibrate]',
    '    steps:',
    '      - run: bun run report',
    '',
  ].join('\n')

  it('runs the job a push runs, and names the one only a schedule runs', async () => {
    const read = await readWorkflows(repoWith({ '.github/workflows/ci.yml': NIGHTLY }))
    const checks = read?.checks ?? []
    expect(checks.map((check) => check.run)).toEqual([
      'bun run lint',
      'bun run typecheck',
      'bun run test',
    ])
    for (const check of checks) {
      expect(check.skip).toBeUndefined()
      expect(check.required).toBe(true)
    }
    expect(read?.from).toEqual(['.github/workflows/ci.yml'])
    // Not a skipped check: something a change never runs is not a check of it.
    expect(read?.unread).toContain(
      ".github/workflows/ci.yml › calibrate runs only when `github.event_name == 'schedule'`, which does not hold for a push, so none of it was read",
    )
    // And what needs it is skipped with it, as GitHub skips it.
    expect(read?.unread).toContain(
      '.github/workflows/ci.yml › report needs calibrate, which does not run on a push, so none of it was read',
    )
  })

  it("answers a step by the same rule, and leaves any other condition CI's", async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [pull_request]',
          'jobs:',
          '  check:',
          '    steps:',
          '      - name: on a pull request',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
          "        if: ${{ github.event_name == 'pull_request' }}",
          '        run: pnpm test',
          '      - name: on a push',
          "        if: github.event_name == 'push'",
          '        run: pnpm bench',
          '      - name: never',
          '        if: false',
          '        run: pnpm nothing',
          '      - name: and main',
          "        if: github.event_name == 'pull_request' && github.ref == 'refs/heads/main'",
          '        run: pnpm main',
          '      - name: always',
          "        if: always() && github.event_name != 'schedule'",
          '        run: pnpm always',
          '',
        ].join('\n'),
      }),
    )
    const byId = new Map((read?.checks ?? []).map((check) => [check.id, check]))
    expect([...byId.keys()]).toEqual(['on-a-pull-request', 'and-main', 'always'])
    expect(byId.get('on-a-pull-request')?.required).toBe(true)
    expect(byId.get('on-a-pull-request')?.skip).toBeUndefined()
    // One clause it cannot answer leaves the whole condition unanswered.
    expect(byId.get('and-main')?.skip).toContain('only CI can answer')
    expect(byId.get('always')?.skip).toContain('only CI can answer')
    expect(read?.unread).toContain(
      ".github/workflows/ci.yml › check › on a push runs only when `github.event_name == 'push'`, which does not hold for a pull request",
    )
    expect(read?.unread).toContain(
      '.github/workflows/ci.yml › check › never says `if: false`, so it never runs',
    )
  })

  it('leaves a job that needs a skipped one to CI where its own condition is not answered', async () => {
    const read = await readWorkflows(
      repoWith({
        '.github/workflows/ci.yml': [
          'on: [push]',
          'jobs:',
          '  nightly:',
          "    if: github.event_name == 'schedule'",
          '    steps:',
          '      - run: pnpm nightly',
          '  after:',
          '    needs: nightly',
          '    if: always()',
          '    steps:',
          '      - name: after',
          '        run: pnpm after',
          '',
        ].join('\n'),
      }),
    )
    expect(read?.checks.map((check) => [check.id, check.skip])).toEqual([
      ['after', 'its job runs only when `always()`, which only CI can answer'],
    ])
  })

  it('stands for a push, or a pull request where that is all it runs on', () => {
    expect(eventOf({ push: null, pull_request: null })).toBe('push')
    expect(eventOf({ push: { branches: ['main'] }, pull_request: null })).toBe('push')
    expect(eventOf(['pull_request'])).toBe('pull_request')
    expect(eventOf('push')).toBe('push')
    // A push of tags is a release, so what a change is here is the pull request.
    expect(eventOf({ push: { tags: ['v*'] }, pull_request: null })).toBe('pull_request')
    // Nothing answered for these, so every condition on the event stays CI's.
    expect(eventOf({ pull_request_target: null })).toBeNull()
    expect(eventOf({ push: { tags: ['v*'] } })).toBeNull()
  })

  it('answers only event_name against a literal, and nothing beside it', () => {
    const cases: [unknown, boolean | null][] = [
      ["github.event_name != 'schedule'", true],
      ["github.event_name == 'schedule'", false],
      ["'push' == github.event_name", true],
      ["github.event_name == 'PUSH'", true],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own syntax
      ["${{ github.event_name == 'push' }}", true],
      ["!(github.event_name == 'schedule')", true],
      ["github.event_name == 'schedule' || github.event_name == 'push'", true],
      ["github.event_name != 'schedule' && github.event_name != 'workflow_dispatch'", true],
      ["github.event_name == 'it''s'", false],
      [true, true],
      [false, false],
      // Everything else is CI's to answer.
      ["github.ref == 'refs/heads/main'", null],
      ["github.event_name == 'push' && success()", null],
      ['github.event_name', null],
      ['!github.event_name', null],
      ["'push' == 'push'", null],
      ["github.event_name == 'push' ||", null],
      ["(github.event_name == 'push'", null],
      ["github.event_name.foo == 'push'", null],
      ["contains(github.event_name, 'push')", null],
      ['', null],
      [3, null],
    ]
    for (const [condition, holds] of cases) {
      expect([condition, holdsOn(condition, 'push')]).toEqual([condition, holds])
    }
    // With no event to stand for, only a boolean is answered.
    expect(holdsOn("github.event_name != 'schedule'", null)).toBeNull()
    expect(holdsOn(false, null)).toBe(false)
  })
})
