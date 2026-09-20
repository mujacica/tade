import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { readChecks } from '../src/manifest.ts'
import { RunnerError } from '../src/port.ts'
import { adoptable, amendChecks, checksYaml, writeChecks } from '../src/write.ts'

// What Tade writes into somebody's repository, and what it refuses to write.

let root = ''

function file(path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

function manifest(): string {
  return readFileSync(join(root, '.tade/checks.yaml'), 'utf8')
}

const WORKFLOW = `name: ci
jobs:
  check:
    steps:
      - uses: actions/checkout@v4
      - name: format
        run: pnpm biome ci .
      - name: tests
        run: pnpm vitest run
      - name: publish
        run: npm publish --tag \${{ github.ref_name }}
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tade-write-'))
})

describe('writeChecks', () => {
  it('writes a manifest that reads back as what was written', async () => {
    const written = await writeChecks(root, [
      { id: 'tests', title: 'Tests', run: 'pnpm test', alone: true, minutes: 20, required: true },
    ])
    expect(written).toEqual({ path: '.tade/checks.yaml', ids: ['tests'], amended: false })
    const read = await readChecks({ name: 'p', root })
    expect(read.source).toBe('manifest')
    expect(read.checks).toEqual([
      { id: 'tests', title: 'Tests', run: 'pnpm test', alone: true, minutes: 20, required: true },
    ])
  })

  it('leaves out what is already the default, so the file stays readable', async () => {
    await writeChecks(root, [
      { id: 'types', title: 'types', run: 'tsc', alone: false, minutes: 10, required: true },
    ])
    const text = manifest()
    expect(text).not.toContain('alone')
    expect(text).not.toContain('minutes')
    expect(text).not.toContain('required')
    expect(text).toContain('run: tsc')
  })

  it('refuses a draft rather than writing a file somebody has to fix by hand', async () => {
    await expect(
      writeChecks(root, [
        { id: 'Not An Id', title: '', run: 'x', alone: false, minutes: 10, required: true },
      ]),
    ).rejects.toThrow(/not a usable check id/)
    await expect(
      writeChecks(root, [
        { id: 'a', title: '', run: '  ', alone: false, minutes: 10, required: true },
      ]),
    ).rejects.toThrow(/no command to run/)
  })
})

describe('amendChecks', () => {
  it('keeps the comments somebody wrote', async () => {
    file(
      '.tade/checks.yaml',
      ['checks:', '  - id: tests', '    # it needs the machine', '    run: pnpm test', ''].join(
        '\n',
      ),
    )
    await amendChecks(root, [{ id: 'types', run: 'tsc' }])
    expect(manifest()).toContain('# it needs the machine')
    expect(manifest()).toContain('tsc')
  })

  it('replaces in place, so amending twice says what amending once said', async () => {
    await amendChecks(root, [
      { id: 'a', run: 'one' },
      { id: 'b', run: 'two' },
    ])
    const first = await amendChecks(root, [{ id: 'a', run: 'changed' }])
    const again = await amendChecks(root, [{ id: 'a', run: 'changed' }])
    expect(first.ids).toEqual(['a', 'b'])
    expect(again.ids).toEqual(['a', 'b'])
    const read = await readChecks({ name: 'p', root })
    expect(read.checks.map((one) => one.run)).toEqual(['changed', 'two'])
  })

  it('removes a check, and says so when there is none to remove', async () => {
    await amendChecks(root, [
      { id: 'a', run: 'one' },
      { id: 'b', run: 'two' },
    ])
    const after = await amendChecks(root, [], { remove: ['a'] })
    expect(after.ids).toEqual(['b'])
    await expect(amendChecks(root, [], { remove: ['gone'] })).rejects.toThrow(
      /no check called gone/,
    )
  })

  it('will not write over a file it cannot read', async () => {
    file('.tade/checks.yaml', 'checks:\n  - id: a\n   run: [unclosed\n')
    await expect(amendChecks(root, [{ id: 'b', run: 'x' }])).rejects.toThrow(/not readable YAML/)
    // The bytes somebody wrote are still there: a file Tade could not
    // understand is a file it must not replace.
    expect(manifest()).toContain('unclosed')
  })

  it('starts a file when there is none', async () => {
    const written = await amendChecks(root, [{ id: 'tests', run: 'pnpm test' }])
    expect(written.amended).toBe(false)
    expect((await readChecks({ name: 'p', root })).source).toBe('manifest')
  })
})

describe('adoptable', () => {
  it('takes the commands and names what only the runner can do', async () => {
    file('.github/workflows/ci.yml', WORKFLOW)
    const found = await adoptable(root)
    expect(found?.checks.map((one) => one.id)).toEqual(['format', 'tests'])
    // The action and the step that reads CI's own expressions are both said,
    // rather than dropped: a manifest quietly holding less than CI does is how
    // somebody comes to believe a tick here means a tick there.
    expect(found?.couldNotTake.join(' ')).toContain('actions/checkout@v4')
    expect(found?.couldNotTake.join(' ')).toContain('publish')
  })

  it('is null for a project with no CI', async () => {
    expect(await adoptable(root)).toBeNull()
  })

  it('writes a manifest that then runs here', async () => {
    file('.github/workflows/ci.yml', WORKFLOW)
    const found = await adoptable(root)
    await writeChecks(root, found?.checks ?? [])
    const read = await readChecks({ name: 'p', root, fromCi: 'show' })
    expect(read.source).toBe('manifest')
    // Adopted, so nothing carries a reason not to run.
    expect(read.checks.every((one) => !one.skip)).toBe(true)
  })
})

describe('checksYaml', () => {
  it('says where CI comes from, so nobody hand-edits the generated file', () => {
    const text = checksYaml([
      { id: 'a', title: 'a', run: 'x', alone: false, minutes: 10, required: true },
    ])
    expect(text).toContain('tade checks workflow --write')
  })
})

describe('RunnerError', () => {
  it('refuses with a kind callers can act on', async () => {
    await expect(amendChecks(root, [])).rejects.toBeInstanceOf(RunnerError)
  })
})
