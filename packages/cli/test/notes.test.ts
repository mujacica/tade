import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// The CLI is spawned for real: each invocation opens the workbench, does its
// work and closes it. Nothing else may hold the home while it runs.

describe('tade remember and notes', () => {
  let home: string
  let env: Record<string, string>

  interface Result {
    code: number | null
    stdout: string
    stderr: string
  }

  const tade = (...args: string[]): Promise<Result> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, ...env },
      })
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

  beforeEach(async () => {
    home = tmp('tade-cli-notes-')
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
  })

  it('has nothing to say before it is told anything', async () => {
    const result = await tade('notes')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('nothing yet')
  })

  it('writes something down and reads it back', async () => {
    const saved = await tade('remember', 'the', 'webhook', 'retries', 'twice')
    expect(saved.code).toBe(0)
    expect(saved.stdout).toBe('noted')

    const notes = await tade('notes')
    expect(notes.stdout).toContain('the webhook retries twice')
  })

  it('keeps the wording exactly, capitals and all', async () => {
    // The whole point of a note is that nothing else can reconstruct it.
    await tade('remember', 'I', 'work', 'from', 'home', 'on', 'Fridays')
    expect((await tade('notes')).stdout).toContain('I work from home on Fridays')
  })

  it('scopes a note, and keeps it out of somewhere else', async () => {
    await tade('remember', '--about', 'checkout/refunds', 'the', 'webhook', 'retries', 'twice')
    await tade('remember', '--about', 'checkout', 'the', 'staging', 'key', 'rotates')
    await tade('remember', 'I', 'work', 'from', 'home')

    const refunds = await tade('notes', 'checkout/refunds')
    expect(refunds.stdout).toContain('the webhook retries twice')
    // What is true of the project is true of its tasks, and general notes always apply.
    expect(refunds.stdout).toContain('the staging key rotates')
    expect(refunds.stdout).toContain('I work from home')

    const elsewhere = await tade('notes', 'search/pagination')
    expect(elsewhere.stdout).not.toContain('the webhook retries twice')
    expect(elsewhere.stdout).toContain('I work from home')
  })

  it('says so when it knows nothing about something', async () => {
    await tade('remember', '--about', 'checkout/refunds', 'something')
    expect((await tade('notes', 'search/pagination')).stdout).toBe(
      'nothing about search/pagination',
    )
  })

  it('reports where each note was filed', async () => {
    await tade('remember', '--about', 'checkout/refunds', 'scoped')
    const saved = await tade('remember', '--about', 'checkout/refunds', 'again')
    expect(saved.stdout).toBe('noted, about checkout/refunds')
  })

  it('keeps a headline beside the words, and says the words first', async () => {
    await tade(
      'remember',
      '--about',
      'checkout',
      '--headline',
      'Staging key rotates monthly',
      'the',
      'staging',
      'key',
      'rotates',
      'on',
      'the',
      '1st',
    )
    const listed = await tade('notes')
    expect(listed.stdout).toContain('the staging key rotates on the 1st')
    expect(listed.stdout).toContain('(Staging key rotates monthly)')
    const json = JSON.parse((await tade('notes', '--json')).stdout)
    expect(json[0]).toMatchObject({
      text: 'the staging key rotates on the 1st',
      summary: 'Staging key rotates monthly',
    })
  })

  it('has a machine-readable form', async () => {
    await tade('remember', '--about', 'checkout', 'the', 'staging', 'key', 'rotates')
    const json = JSON.parse((await tade('notes', '--json')).stdout)
    expect(json).toHaveLength(1)
    expect(json[0]).toMatchObject({ text: 'the staging key rotates', scope: 'checkout' })
    expect(typeof json[0].at).toBe('string')
  })
})
