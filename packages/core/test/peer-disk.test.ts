import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { PEERS_BYTES_MOST, PeerRoom, peersBytes, peersFullSays } from '../src/peer-disk.ts'

// One ceiling on everything other machines hand this one, under
// `<home>/machines/`: what makes a hostile machine's answers a bounded cost.

describe('the room other machines’ gifts share', () => {
  it('counts every file under machines/, folders inside folders included, and nought where there is none', async () => {
    const home = tmp('tade-peer-disk-')
    expect(await peersBytes(home)).toBe(0)
    const copy = join(home, 'machines', '00000001-0000-4000-8000-000000000000')
    mkdirSync(join(copy, 'conversation', 'tool-results'), { recursive: true })
    writeFileSync(join(copy, 'events.jsonl'), 'x'.repeat(1_000))
    writeFileSync(join(copy, 'conversation', 'tool-results', 'a.json.part'), 'y'.repeat(500))
    writeFileSync(join(home, 'events.jsonl'), 'z'.repeat(9_999))
    // This machine's own journal is not another machine's gift.
    expect(await peersBytes(home)).toBe(1_500)
  })

  it('says no once full, counts what its taker wrote until the next walk, and walks again in time', async () => {
    const home = tmp('tade-peer-room-')
    mkdirSync(join(home, 'machines', 'm'), { recursive: true })
    writeFileSync(join(home, 'machines', 'm', 'events.jsonl'), 'x'.repeat(600))
    const room = new PeerRoom(home, { most: 1_000, every: 60_000 })
    expect(await room.fits(400, 0)).toBe(true)
    expect(await room.fits(401, 0)).toBe(false)
    room.spent(400)
    expect(await room.fits(1, 1)).toBe(false)
    // A copy deleted by hand is room again by the next walk.
    writeFileSync(join(home, 'machines', 'm', 'events.jsonl'), '')
    expect(await room.fits(1, 30_000)).toBe(false)
    expect(await room.fits(1_000, 60_000)).toBe(true)
    expect(room.says()).toBe(peersFullSays(1_000))
  })

  it('is gibibytes by default, and says where the way out is', () => {
    expect(PEERS_BYTES_MOST).toBe(4 * 1024 ** 3)
    expect(peersFullSays()).toContain('4096 MB')
    expect(peersFullSays()).toContain('safe to delete')
  })
})
