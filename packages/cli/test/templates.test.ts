import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade templates` and `tade personas` from the outside: against a real
// repository, with a home made for the test, and with no window anywhere —
// because every one of these but `publish` is a question, and a question never
// needs the window.
//
// `publish` is here and has no tool anywhere, which is the enforcement: the
// act that turns a file somebody wrote or imported into something the
// orchestrator may stamp out is a person at this machine.

describe('tade templates', () => {
  let home: string
  let repo: ReturnType<typeof mkrepo>
  let env: Record<string, string>

  const tade = (
    ...args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.stderr.on('data', (d: string) => {
        stderr += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })

  const DRAFT = `template: mine
version: 1
title: Fix a reported bug
project_input: project
said_input: summary
name_suffix: ticket
inputs:
  project: { kind: project }
  ticket: { kind: slug }
  summary: { kind: text }
agents:
  - name: fix
    persona: implementer
    prompt: Fix it.
  - name: read
    persona: reviewer
    after: [{ agent: fix, why: a change is read by somebody who did not write it }]
`

  const draft = (text = DRAFT, name = 'mine') => {
    mkdirSync(join(home, 'templates', 'drafts'), { recursive: true })
    writeFileSync(join(home, 'templates', 'drafts', `${name}.yaml`), text)
  }

  beforeEach(() => {
    repo = mkrepo()
    home = tmp('tade-cli-templates-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: worktree\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
  })

  it('lists the ones Tade ships, with nothing anywhere', async () => {
    const { code, stdout } = await tade('templates')
    expect(code).toBe(0)
    expect(stdout).toContain('bug-repro-fix-review — built in, published @1')
    expect(stdout).toContain('research-then-plan — built in, published @1')
  })

  it('lists Tade’s own personas, and says the rule where somebody is reading', async () => {
    const { code, stdout } = await tade('personas')
    expect(code).toBe(0)
    expect(stdout).toContain('implementer — Implementer (built in)')
    expect(stdout).toContain('never say what an agent is allowed')
  })

  it('checks a draft, and says to dry-run it before publishing', async () => {
    draft()
    const { code, stdout } = await tade('templates', 'check', 'mine')
    expect(code).toBe(0)
    expect(stdout).toContain('mine@1 holds together')
    expect(stdout).toContain('Dry-run it against the real tree before you publish it')
  })

  it('refuses a draft with a cycle in it, naming who waits on whom', async () => {
    draft(DRAFT.replace('  - name: read', '    after: [{ agent: read, why: so }]\n  - name: read'))
    const { code, stderr } = await tade('templates', 'check', 'mine')
    expect(code).toBe(2)
    expect(stderr).toMatch(/fix and read wait on each other/)
  })

  it('refuses a draft naming a persona there is not', async () => {
    draft(DRAFT.replace('persona: implementer', 'persona: wizard'))
    const { code, stderr } = await tade('templates', 'check', 'mine')
    expect(code).toBe(2)
    expect(stderr).toMatch(/wants the persona wizard/)
  })

  it('dry-runs a draft and makes nothing: no task folder anywhere after it', async () => {
    draft()
    const { code, stdout } = await tade(
      'templates',
      'dry-run',
      'mine',
      '-i',
      'project=app',
      '-i',
      'ticket=318',
      '-i',
      'summary=export breaks on an empty selection',
    )
    expect(code).toBe(0)
    expect(stdout).toContain('mine@1 (unpublished draft)')
    expect(stdout).toContain('app/fix-318')
    expect(stdout).toContain('app/read-318')
    expect(stdout).toContain(
      'after app/fix-318 — a change is read by somebody who did not write it',
    )
    expect(stdout).toContain('This template grants nothing')
    expect(stdout).toContain('Nothing was made, and nothing was started.')
    // It is honest about the one thing it cannot read from out here.
    expect(stdout).toContain('Plan windows: cannot tell from here')
    // And it genuinely made nothing.
    const { stdout: tasks } = await tade('status', '--json')
    expect(tasks).not.toContain('fix-318')
  })

  it('says which input is missing rather than stamping out an empty one', async () => {
    draft()
    const { code, stdout } = await tade('templates', 'dry-run', 'mine', '-i', 'project=app')
    expect(code).toBe(2)
    expect(stdout).toContain('ticket is not filled in')
    expect(stdout).toContain('summary is not filled in')
    expect(stdout).toContain('Nothing was made, and nothing was started.')
  })

  it('refuses --input that is not name=value rather than guessing', async () => {
    draft()
    const { code, stderr } = await tade('templates', 'dry-run', 'mine', '-i', 'justaword')
    expect(code).toBe(2)
    expect(stderr).toContain('--input takes name=value')
  })

  it('publishes a snapshot with the personas folded in, and refuses to change it', async () => {
    draft()
    const first = await tade('templates', 'publish', 'mine')
    expect(first.code).toBe(0)
    expect(first.stdout).toMatch(/mine@1 published \(sha256:[0-9a-f]{12}\)/)
    const snapshot = readFileSync(join(home, 'templates', 'published', 'mine', '1.yaml'), 'utf8')
    expect(snapshot).toContain('from_persona: implementer')
    expect(snapshot).toContain('You are making one change')
    expect(snapshot).not.toMatch(/\d{4}-\d{2}-\d{2}T/)

    // The same bytes again is nothing.
    const again = await tade('templates', 'publish', 'mine')
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('already published, unchanged')

    // Different bytes under the same version is refused, and the file stands.
    draft(DRAFT.replace('Fix it.', 'Fix it differently.'))
    const changed = await tade('templates', 'publish', 'mine')
    expect(changed.code).toBe(2)
    expect(changed.stderr).toMatch(/bump version to 2/)
    expect(readFileSync(join(home, 'templates', 'published', 'mine', '1.yaml'), 'utf8')).toBe(
      snapshot,
    )
  })

  // The bug this is here to stop: `check` read the new draft and `dry-run`
  // read last week's published version without saying so — in exactly the
  // order `check` tells somebody to work in.
  it('dry-runs the draft, not the published version, when somebody is about to publish', async () => {
    draft()
    await tade('templates', 'publish', 'mine')
    draft(DRAFT.replace('version: 1', 'version: 2').replace('Fix it.', 'Fix it the new way.'))
    const { code, stdout } = await tade(
      'templates',
      'dry-run',
      'mine',
      '-i',
      'project=app',
      '-i',
      'ticket=318',
      '-i',
      'summary=x',
    )
    expect(code).toBe(0)
    expect(stdout).toContain('mine@2 (unpublished draft)')
  })

  it('dry-runs and shows a published version when one is named as mine@n', async () => {
    draft()
    await tade('templates', 'publish', 'mine')
    draft(DRAFT.replace('version: 1', 'version: 2'))
    const dry = await tade(
      'templates',
      'dry-run',
      'mine@1',
      '-i',
      'project=app',
      '-i',
      'ticket=318',
      '-i',
      'summary=x',
    )
    expect(dry.code).toBe(0)
    expect(dry.stdout).toMatch(/mine@1 \(sha256:[0-9a-f]{12}\)/)
    const shown = await tade('templates', 'show', 'mine@1')
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('there is also a draft at version 2, not published yet')
    const missing = await tade('templates', 'dry-run', 'mine@99', '-i', 'project=app')
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('mine@99 is not published')
  })

  it('shows a published version with its hash, and says it never changes', async () => {
    draft()
    await tade('templates', 'publish', 'mine')
    const { code, stdout } = await tade('templates', 'show', 'mine')
    expect(code).toBe(0)
    expect(stdout).toMatch(/mine@1 \(sha256:[0-9a-f]{12}\)/)
    expect(stdout).toContain('a published version never changes')
    expect(stdout).toContain('the request, verbatim')
  })

  it('refuses to publish a draft that does not hold together, and writes nothing', async () => {
    draft(DRAFT.replace('persona: implementer', 'persona: wizard'))
    const { code, stderr } = await tade('templates', 'publish', 'mine')
    expect(code).toBe(2)
    expect(stderr).toMatch(/wants the persona wizard/)
    const { stdout } = await tade('templates', 'list')
    expect(stdout).toContain('mine — drafted, nothing published')
  })

  it('names a persona of yours that will not read, and keeps loading the others', async () => {
    mkdirSync(join(home, 'personas', 'active'), { recursive: true })
    writeFileSync(
      join(home, 'personas', 'active', 'mine.md'),
      '---\npersona: mine\naccount: somebody-elses\n---\n\nDo it.\n',
    )
    const { code, stdout } = await tade('personas', 'list')
    expect(code).toBe(0)
    expect(stdout).toContain('mine — will not read, so it is not loaded')
    expect(stdout).toContain("account is not a persona's to set")
    expect(stdout).toContain('implementer — Implementer (built in)')
  })

  // A name from a command line is a value from outside being joined onto a
  // path, and the message must not name a file somewhere else either.
  it.each(['check', 'show', 'dry-run', 'publish', 'reject'])(
    'refuses a name that climbs out of the folder: %s',
    async (verb) => {
      const { code, stderr } = await tade('templates', verb, '../../../../etc/passwd')
      expect(code).toBe(2)
      expect(stderr).toContain('is not a name Tade will use')
      expect(stderr).not.toContain('/etc/passwd.yaml')
    },
  )

  it('names a draft that will not read rather than dropping it from the list', async () => {
    draft('template: mine\nversion: [this: is\n')
    const { code, stdout } = await tade('templates', 'list')
    expect(code).toBe(0)
    expect(stdout).toContain('its draft will not read')
  })
})
