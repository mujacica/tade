import { describe, expect, it } from 'vitest'
import type { ChecksManifest } from '../src/manifest.ts'
import { workflowFor, workflowMatches } from '../src/workflow.ts'

const manifest: ChecksManifest = {
  checks: [
    {
      id: 'format',
      title: 'Formatting',
      run: 'pnpm exec biome ci .',
      alone: false,
      minutes: 3,
      required: true,
    },
    {
      id: 'tests',
      title: 'Tests',
      run: 'pnpm exec vitest run',
      alone: true,
      minutes: 10,
      required: true,
    },
    {
      id: 'only-ci',
      title: 'Only CI',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's own syntax
      run: 'deploy ${{ secrets.KEY }}',
      alone: false,
      minutes: 1,
      required: false,
      skip: 'needs CI',
    },
  ],
  ci: {
    runs_on: ['ubuntu-latest', 'macos-latest'],
    node: '22',
    setup: [
      { uses: 'actions/checkout@v4' },
      { uses: 'actions/setup-node@v4', with: { 'node-version': '22' } },
    ],
  },
  source: 'manifest',
  from: '.tade/checks.yaml',
  problems: [],
}

describe('the workflow the manifest implies', () => {
  it('names every step after the check it runs, so a row lines up with CI', () => {
    const text = workflowFor(manifest)
    expect(text).toContain('      - name: format\n        run: pnpm exec biome ci .')
    expect(text).toContain('      - name: tests\n        run: pnpm exec vitest run')
  })

  it('keeps the other rows reporting, and supersedes an old run', () => {
    const text = workflowFor(manifest)
    expect(text).toContain('fail-fast: false')
    expect(text).toContain('cancel-in-progress: true')
    expect(text).toContain('os: [ubuntu-latest, macos-latest]')
  })

  it('writes the setup steps out as the manifest gave them', () => {
    const text = workflowFor(manifest)
    expect(text).toContain('      - uses: actions/checkout@v4')
    expect(text).toContain(
      '      - uses: actions/setup-node@v4\n        with:\n          node-version: "22"',
    )
  })

  it('leaves out what cannot run here at all — CI would run it, this file says it', () => {
    expect(workflowFor(manifest)).not.toContain('only-ci')
  })

  it('says where to edit it, and is the same file every time', () => {
    const text = workflowFor(manifest)
    expect(text.split('\n')[0]).toContain('.tade/checks.yaml')
    expect(workflowFor(manifest)).toBe(text)
    expect(workflowMatches(text, manifest)).toBe(true)
    expect(workflowMatches(`${text}\n# hand-edited\n`, manifest)).toBe(false)
  })

  it('does not draw a matrix for one runner', () => {
    const one = workflowFor({ ...manifest, ci: { ...manifest.ci, runs_on: ['ubuntu-latest'] } })
    expect(one).toContain('runs-on: ubuntu-latest')
    expect(one).not.toContain('matrix')
  })
})
