import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { devicesIn, devicesPath } from '../src/devices.ts'
import { mintOwner } from '../src/owner.ts'
import { writeCode } from '../src/pending.ts'
import { homeFor } from './harness.ts'

// TADE-Y: a window opened before every device was the person's own (95e8b960)
// keeps that code for as long as it stays open, while `tade web pair` runs
// what is installed now. The owner line the newer shell wrote had no `scopes`,
// `projects` or `granted`, the older window's strict schema required them,
// and the device it had just let in was refused as having no session.
//
// The two schemas below are that window's `paired` and `pending` lines, copied
// from 95e8b960^ (`packages/web/src/devices.ts`) and frozen: they are what a
// line written outside the window has to pass.

const SCOPES = z.enum([
  'read',
  'answer',
  'steer',
  'ask',
  'draft',
  'agents',
  'projects',
  'configure',
])
const GRANTS = z.enum([
  'titles',
  'intent',
  'notes',
  'findings',
  'spend',
  'reviews',
  'accounts',
  'talk',
  'requests',
  'material',
  'workflows',
  'lanes',
  'settings',
])

const OlderPaired = z.strictObject({
  kind: z.literal('paired'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  label: z.string().max(120),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  host: z.string().max(260),
  csrf: z.string().max(120),
  until: z.string(),
  scopes: z.array(SCOPES),
  projects: z.array(z.string()).nullable(),
  granted: z.array(GRANTS),
  from: z.string().max(64),
  owner: z.literal(true).optional(),
})

const OlderPending = z.strictObject({
  kind: z.literal('pending'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  until: z.string(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  host: z.string().max(260),
  label: z.string().max(120),
  scopes: z.array(SCOPES),
  projects: z.array(z.string()).nullable(),
  granted: z.array(GRANTS),
})

async function linesIn(home: string): Promise<unknown[]> {
  const text = await readFile(devicesPath(home), 'utf8')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

describe('a line `tade web pair` writes, read by a window opened before it', () => {
  it('is an owner the older window knows, with everything, and an owner here', async () => {
    const home = await homeFor('older-owner')
    const owner = await mintOwner(home, { port: 7654, label: 'mac', from: '' }, Date.now())
    const [line] = await linesIn(home)
    const older = OlderPaired.parse(line)
    expect(older).toMatchObject({ device: owner.device, owner: true, projects: null })
    expect(older.scopes).toEqual(SCOPES.options)
    expect(older.granted).toEqual(GRANTS.options)
    // And this Tade still reads it as it did: an owner, never in the clear.
    const read = devicesIn(await readFile(devicesPath(home), 'utf8'))
    expect(read.skipped).toBe(0)
    expect(read.devices[0]).toMatchObject({ id: owner.device, owner: true, clear: false })
  })

  it('is a code the older window can claim, as its own `tade web pair` wrote one', async () => {
    const home = await homeFor('older-pending')
    const code = await writeCode(home, { host: 'mac.example.ts.net', label: '' }, Date.now())
    const [line] = await linesIn(home)
    const older = OlderPending.parse(line)
    expect(older).toMatchObject({ device: code.device, projects: null })
    expect(older.scopes).toEqual(SCOPES.options)
    const read = devicesIn(await readFile(devicesPath(home), 'utf8'))
    expect(read.skipped).toBe(0)
    expect(read.pending.map((one) => one.id)).toEqual([code.device])
  })
})
