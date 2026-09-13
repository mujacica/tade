import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// The CLI is spawned for real: each invocation opens the workbench, does its
// work and closes it. Nothing else may hold the home while it runs.

describe('wilco remember and notes', () => {
  let home: string
  let env: Record<string, string>

  interface Result {
    code: number | null
    stdout: string
    stderr: string
  }

  const wilco = (...args: string[]): Promise<Result> =>
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
    home = tmp('wilco-cli-notes-')
    env = { WILCO_HOME: home, WILCO_NO_GH: '1', HOME: home }
  })

  it('has nothing to say before it is told anything', async () => {
    const result = await wilco('notes')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('nothing yet')
  })

  it('writes something down and reads it back', async () => {
    const saved = await wilco('remember', 'the', 'webhook', 'retries', 'twice')
    expect(saved.code).toBe(0)
    expect(saved.stdout).toBe('noted')

    const notes = await wilco('notes')
    expect(notes.stdout).toContain('the webhook retries twice')
  })

  it('keeps the wording exactly, capitals and all', async () => {
    // The whole point of a note is that nothing else can reconstruct it.
    await wilco('remember', 'I', 'work', 'from', 'home', 'on', 'Fridays')
    expect((await wilco('notes')).stdout).toContain('I work from home on Fridays')
  })

  it('scopes a note, and keeps it out of somewhere else', async () => {
    await wilco('remember', '--about', 'checkout/refunds', 'the', 'webhook', 'retries', 'twice')
    await wilco('remember', '--about', 'checkout', 'the', 'staging', 'key', 'rotates')
    await wilco('remember', 'I', 'work', 'from', 'home')

    const refunds = await wilco('notes', 'checkout/refunds')
    expect(refunds.stdout).toContain('the webhook retries twice')
    // What is true of the project is true of its tasks, and general notes always apply.
    expect(refunds.stdout).toContain('the staging key rotates')
    expect(refunds.stdout).toContain('I work from home')

    const elsewhere = await wilco('notes', 'search/pagination')
    expect(elsewhere.stdout).not.toContain('the webhook retries twice')
    expect(elsewhere.stdout).toContain('I work from home')
  })

  it('says so when it knows nothing about something', async () => {
    await wilco('remember', '--about', 'checkout/refunds', 'something')
    expect((await wilco('notes', 'search/pagination')).stdout).toBe(
      'nothing about search/pagination',
    )
  })

  it('reports where each note was filed', async () => {
    await wilco('remember', '--about', 'checkout/refunds', 'scoped')
    const saved = await wilco('remember', '--about', 'checkout/refunds', 'again')
    expect(saved.stdout).toBe('noted, about checkout/refunds')
  })

  it('has a machine-readable form', async () => {
    await wilco('remember', '--about', 'checkout', 'the', 'staging', 'key', 'rotates')
    const json = JSON.parse((await wilco('notes', '--json')).stdout)
    expect(json).toHaveLength(1)
    expect(json[0]).toMatchObject({ text: 'the staging key rotates', scope: 'checkout' })
    expect(typeof json[0].at).toBe('string')
  })
})
