import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileHash, keyDigest, personaDirs, templateDirs, writeCarried } from '@tade/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  applyCarry,
  type CarryAnswer,
  type CarryBody,
  type CarryLine,
  carryHere,
  carryingAt,
  changesIn,
  type SignInHere,
  type WebCarrying,
} from '../src/carried.ts'
import type { Device } from '../src/devices.ts'

// Another machine's setup carried here (`carried.ts`), against a real home: a
// config file written by `writeSetting` and read back, a journal of lines, and
// the decisions `@tade/core`'s `carry.ts` makes — which is what a remote does
// when the Mac that added it carries its preferences over.

const PERSONA = `---
persona: reviewer
title: Reviewer
done: said
---

Read the change before you say anything about it.
`

const TEMPLATE = (version: number) => `template: triage
version: ${version}
title: Look at a report
project_input: project
said_input: summary
inputs:
  project: { kind: project }
  summary: { kind: text }
agents:
  - name: look
    persona: implementer
    prompt: Look at it.
`

describe('carrying a setup here', () => {
  let home: string
  let config: string
  let lines: CarryLine[]
  let carrying: WebCarrying
  const signIns: SignInHere[] = [
    {
      harness: 'claude-code',
      account: null,
      signedIn: true,
      until: 1_900_000_000_000,
      problem: null,
    },
  ]

  const carry = (body: Partial<CarryBody>, device = 'd1') =>
    applyCarry(
      { from: 'mac', complete: false, settings: [], files: [], force: [], ...body },
      device,
      carrying,
    )
  const file = () => readFileSync(config, 'utf8')
  const outcomes = (answer: CarryAnswer) =>
    Object.fromEntries(answer.settings.map((one) => [one.path, one.outcome]))

  beforeEach(() => {
    home = tmp('tade-carried-')
    config = join(home, 'config.yaml')
    lines = []
    const log = async (line: CarryLine) => {
      lines.push(line)
    }
    carrying = carryingAt({
      home,
      configPath: config,
      lines: async () => lines,
      write: (path, value, carry, by) => writeCarried(config, { path, value, carry, by }, log),
      log,
      signIns: async () => signIns,
      machine: 'vps',
    })
  })

  it('writes the preferences a fresh machine has none of, saying each was carried', async () => {
    const answer = await carry({
      settings: [
        { path: 'agents.commit', value: 'as-you-go' },
        { path: 'approvals.auto_allow', value: ['read'] },
      ],
    })
    expect(outcomes(answer)).toEqual({
      'agents.commit': 'written',
      'approvals.auto_allow': 'written',
    })
    expect(file()).toContain('commit: as-you-go')
    expect(lines.map((one) => one.detail)).toEqual([
      { path: 'agents.commit', was: '', now: 'as-you-go', by: 'device d1', carried: 'mac' },
      { path: 'approvals.auto_allow', was: '', now: '["read"]', by: 'device d1', carried: 'mac' },
    ])
    expect(answer.machine).toBe('vps')
    expect(answer.signIns).toEqual(signIns)
  })

  it('refuses what is this machine’s own, whatever was sent', async () => {
    const answer = await carry({
      settings: [
        { path: 'projects.app.root', value: '/src/app' },
        { path: 'surfaces.web.public', value: 'evil.example' },
      ],
      force: ['projects.app.root'],
    })
    expect(outcomes(answer)).toEqual({
      'projects.app.root': 'refused',
      'surfaces.web.public': 'refused',
    })
    expect(answer.settings[0]?.why).toMatch(/folder on this machine/)
    expect(() => file()).toThrow()
  })

  it('leaves a value somebody here changed, says it back, and writes it on a press', async () => {
    writeFileSync(config, 'agents:\n  commit: never\n')
    lines.push({
      type: 'config_changed',
      detail: { path: 'agents.commit', was: '', now: 'never', by: 'window' },
    })
    const left = await carry({ settings: [{ path: 'agents.commit', value: 'as-you-go' }] })
    expect(left.settings).toEqual([{ path: 'agents.commit', outcome: 'theirs', theirs: 'never' }])
    expect(file()).toContain('commit: never')
    const pressed = await carry({
      settings: [{ path: 'agents.commit', value: 'as-you-go' }],
      force: ['agents.commit'],
    })
    expect(outcomes(pressed)).toEqual({ 'agents.commit': 'written' })
    expect(file()).toContain('commit: as-you-go')
  })

  it('keeps carried values in step, and takes one away only while it is still the carried one', async () => {
    await carry({
      settings: [
        { path: 'agents.commit', value: 'as-you-go' },
        { path: 'queue.holds', value: 'ask' },
      ],
    })
    // Somebody edits one of them by hand; the Mac then stops setting both.
    writeFileSync(config, file().replace('holds: ask', 'holds: orchestrator'))
    const answer = await carry({ settings: [], complete: true })
    expect(outcomes(answer)).toEqual({ 'agents.commit': 'written' })
    expect(file()).not.toContain('commit:')
    expect(file()).toContain('holds: orchestrator')
    // Another device's carry is never taken away by this one's.
    await carry({ settings: [{ path: 'agents.push', value: 'never' }] }, 'd2')
    expect(outcomes(await carry({ complete: true }))).toEqual({})
    expect(file()).toContain('push: never')
  })

  it('compares a key it was only told the digest of, and writes it 0600 on a press', async () => {
    const key = 'jev-0123456789abcdef'
    const told = await carry({
      settings: [{ path: 'extensions.jev.key', digest: keyDigest(key) }],
    })
    expect(outcomes(told)).toEqual({ 'extensions.jev.key': 'waiting' })
    expect(() => file()).toThrow()
    const sent = await carry({ settings: [{ path: 'extensions.jev.key', value: key }] })
    expect(outcomes(sent)).toEqual({ 'extensions.jev.key': 'written' })
    expect(file()).toContain(key)
    expect(statSync(config).mode & 0o777).toBe(0o600)
    // The line says it was sent, and how long it was, and never what it was.
    expect(JSON.stringify(lines)).not.toContain(key)
    expect(lines.at(-1)?.detail).toMatchObject({ now: '20 characters', carried: 'mac' })
    expect(
      outcomes(await carry({ settings: [{ path: 'extensions.jev.key', digest: keyDigest(key) }] })),
    ).toEqual({ 'extensions.jev.key': 'same' })
    // A different one there is replaced on the press, and its value is never said back.
    writeFileSync(config, file().replace(key, 'jev-somebody-elses-key'))
    const replaced = await carry({ settings: [{ path: 'extensions.jev.key', value: key }] })
    expect(replaced.settings).toEqual([{ path: 'extensions.jev.key', outcome: 'replaced' }])
    expect(JSON.stringify(replaced)).not.toContain('somebody-elses')
  })

  it('lands a route’s name after the route, and refuses what will not load with the reason', async () => {
    const answer = await carry({
      settings: [
        { path: 'workers.default', value: 'fast' },
        { path: 'workers.routes.fast.harness', value: 'claude-code' },
        { path: 'agents.commit', value: 'whenever' },
      ],
    })
    expect(outcomes(answer)).toEqual({
      'workers.default': 'written',
      'workers.routes.fast.harness': 'written',
      'agents.commit': 'refused',
    })
    expect(answer.settings.find((one) => one.path === 'agents.commit')?.why).toMatch(/Invalid/)
    expect(file()).not.toContain('whenever')
  })

  it('carries the personas written and the templates published, and rewrites neither silently', async () => {
    const files = [
      { kind: 'persona' as const, name: 'reviewer', text: PERSONA },
      { kind: 'template' as const, name: 'triage', version: 1, text: TEMPLATE(1) },
    ]
    const first = await carry({ files })
    expect(first.files.map((one) => one.outcome)).toEqual(['written', 'written'])
    const persona = join(personaDirs(home).active, 'reviewer.md')
    expect(readFileSync(persona, 'utf8')).toBe(PERSONA)
    expect(lines.at(-1)?.detail).toMatchObject({ kind: 'template', version: 1, from: 'mac' })
    expect(lines.at(-2)?.detail).toMatchObject({ kind: 'persona', hash: fileHash(PERSONA) })
    // Again: already so.
    expect((await carry({ files })).files.map((one) => one.outcome)).toEqual(['same', 'same'])
    // Somebody here edits the persona; a version 1 with other bytes is published here.
    writeFileSync(persona, `${PERSONA}\nAnd say thank you.\n`)
    mkdirSync(join(templateDirs(home).published, 'triage'), { recursive: true })
    writeFileSync(
      join(templateDirs(home).published, 'triage', '1.yaml'),
      TEMPLATE(1).replace('Look at it.', 'Other.'),
    )
    const again = await carry({ files })
    expect(again.files.map((one) => one.outcome)).toEqual(['theirs', 'refused'])
    expect(readFileSync(persona, 'utf8')).toContain('thank you')
    // A persona is written over on a press; a published version never is.
    const forced = await carry({ files, force: ['persona reviewer', 'template triage@1'] })
    expect(forced.files.map((one) => one.outcome)).toEqual(['written', 'refused'])
    expect(readFileSync(persona, 'utf8')).toBe(PERSONA)
  })

  it('refuses a file that would not load here, rather than writing a broken one', async () => {
    const answer = await carry({
      files: [{ kind: 'template', name: 'triage', version: 2, text: TEMPLATE(1) }],
    })
    expect(answer.files[0]).toMatchObject({ outcome: 'refused' })
    expect(answer.files[0]?.why).toMatch(/version 1/)
  })

  it('folds the newest line per path, and only a carry’s line names a device', () => {
    expect(
      changesIn([
        {
          type: 'config_changed',
          detail: { path: 'a', now: 'x', by: 'device d1', carried: 'mac' },
        },
        { type: 'config_changed', detail: { path: 'a', now: 'y', by: 'device d1' } },
        { type: 'web_paired', detail: { path: 'b' } },
      ]),
    ).toEqual([{ path: 'a', now: 'y', carried: false, device: null }])
  })
})

describe('the route', () => {
  const owner = { id: 'd1', owner: true } as Device
  const phone = { id: 'd2', owner: false } as Device
  const asking = (body: unknown) =>
    Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} }) as never
  const nothing: WebCarrying = {
    written: async () => ({}),
    changes: async () => [],
    carriedFiles: async () => new Map(),
    write: async () => {},
    file: async () => null,
    put: async () => {},
    signIns: async () => [],
    machine: () => 'vps',
  }
  const body = { from: 'mac', complete: false, settings: [] }

  it('answers an owner, and nobody else', async () => {
    expect(await carryHere(asking(body), owner, nothing)).toEqual({
      body: { machine: 'vps', settings: [], files: [], signIns: [] },
    })
    const refused = await carryHere(asking(body), phone, nothing)
    expect('refusal' in refused && refused.refusal.error).toBe('out_of_scope')
  })

  it('is a path nobody built where the window did not wire it', async () => {
    const refused = await carryHere(asking(body), owner, undefined)
    expect('refusal' in refused && refused.refusal.error).toBe('no_such')
  })

  it('refuses a body that is not a carry', async () => {
    for (const bad of [
      { ...body, settings: [{ path: '../config', value: 1 }] },
      { ...body, settings: [{ path: 'agents.commit' }] },
      { ...body, files: [{ kind: 'persona', name: '../x', text: '' }] },
      { ...body, extra: true },
    ]) {
      const refused = await carryHere(asking(bad), owner, nothing)
      expect('refusal' in refused && refused.refusal.error, JSON.stringify(bad)).toBe('malformed')
    }
  })
})
