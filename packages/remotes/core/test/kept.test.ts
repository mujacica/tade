import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION, type Snapshot } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { readSnapshot } from '../src/held.ts'
import { keptPath, readKept, writeKept } from '../src/kept.ts'

// What this machine last heard from another, kept on its disk so `as of`
// survives a restart: written whole, read back for its shape, and nothing
// where the file is not one.

const made: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tade-kept-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function projection(): Snapshot {
  const read = readSnapshot(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      fresh: {
        at: '2026-11-22T14:00:00.000Z',
        epoch: 'e1',
        rev: 4,
        openedAt: '',
        machineUpSince: null,
        spendSince: null,
        warnings: [],
      },
      you: {},
      pages: {},
      projects: [{ name: 'api', title: '', open: true, can: [], cannot: [] }],
      tasks: [],
      queue: [],
      findings: [],
      notes: [],
      plans: [],
      chat: [],
      intake: [],
      sources: [],
      runs: [],
      workflows: [],
      machines: [],
    }),
  )
  if (typeof read === 'string') throw new Error(read)
  return read
}

describe('what is kept of another machine', () => {
  it('reads back what was written, under the machine’s own folder, kept from other people', async () => {
    const home = scratch()
    await writeKept(home, 'vps', {
      projection: projection(),
      heardAt: 1_000,
      cursor: { epoch: 'e1', rev: 4 },
    })
    const path = keptPath(home, 'vps') as string
    expect(path).toBe(join(home, 'machines', 'vps', 'projection.json'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const back = await readKept(home, 'vps')
    expect(back?.heardAt).toBe(1_000)
    expect(back?.cursor).toEqual({ epoch: 'e1', rev: 4 })
    expect(back?.projection.projects.map((one) => one.name)).toEqual(['api'])
  })

  it('is nothing where nothing was kept, and says so where what is there is not a projection', async () => {
    const home = scratch()
    expect(await readKept(home, 'vps')).toBeNull()
    await writeKept(home, 'vps', { projection: projection(), heardAt: 1, cursor: null })
    const path = keptPath(home, 'vps') as string
    writeFileSync(path, '{"projection": {"v": 999}, "heardAt": 1}')
    await expect(readKept(home, 'vps')).rejects.toThrow(/is not a projection/)
    writeFileSync(path, 'not json')
    await expect(readKept(home, 'vps')).rejects.toThrow(/is not JSON/)
    // Left as it was: the next write replaces it, and nothing here deletes it.
    expect(readFileSync(path, 'utf8')).toBe('not json')
  })

  it('makes no path of a name the config could not hold', async () => {
    expect(keptPath('/h', '../etc')).toBeNull()
    expect(await readKept('/h', '../etc')).toBeNull()
  })
})
