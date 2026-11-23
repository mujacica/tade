import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECT_TICKET_MS,
  connectTicketHolds,
  connectTicketsPath,
  mintConnectTicket,
  TICKETS_HELD,
  ticketed,
} from '../src/connect-tickets.ts'

// The tickets a press on the connect pages carries on this machine's own door:
// the digest on the disk, the ticket in the link alone, an hour each, and a
// file another account cannot read.

const home = () => mkdtemp(join(tmpdir(), 'tade-connect-tickets-'))
const NOW = Date.parse('2026-11-23T10:00:00Z')

describe('a connect ticket', () => {
  it('holds once minted, for an hour, and never after', async () => {
    const at = await home()
    const { ticket, until } = await mintConnectTicket(at, NOW)
    expect(until).toBe(NOW + CONNECT_TICKET_MS)
    expect(await connectTicketHolds(at, ticket, NOW)).toBe(true)
    expect(await connectTicketHolds(at, ticket, until - 1)).toBe(true)
    expect(await connectTicketHolds(at, ticket, until)).toBe(false)
  })

  it('writes its digest and never itself, in a file only you can read', async () => {
    const at = await home()
    const { ticket } = await mintConnectTicket(at, NOW)
    const path = connectTicketsPath(at)
    expect(await readFile(path, 'utf8')).not.toContain(ticket)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('holds nothing never minted, nothing in another shape, and nothing with no file at all', async () => {
    const at = await home()
    expect(await connectTicketHolds(at, 'A'.repeat(27), NOW)).toBe(false)
    await mintConnectTicket(at, NOW)
    for (const presented of [null, '', 'A'.repeat(27), 'A'.repeat(28), '../../etc/passwd']) {
      expect(await connectTicketHolds(at, presented, NOW), String(presented)).toBe(false)
    }
  })

  it('skips a damaged line rather than throwing over the rest', async () => {
    const at = await home()
    const { ticket } = await mintConnectTicket(at, NOW)
    const path = connectTicketsPath(at)
    await writeFile(path, `{"digest":"nope\n${await readFile(path, 'utf8')}not json\n`)
    expect(await connectTicketHolds(at, ticket, NOW)).toBe(true)
  })

  it('keeps no more than it was built to, the oldest going first', async () => {
    const at = await home()
    const first = await mintConnectTicket(at, NOW)
    for (let i = 0; i < TICKETS_HELD; i++) await mintConnectTicket(at, NOW + i + 1)
    expect(await connectTicketHolds(at, first.ticket, NOW + TICKETS_HELD)).toBe(false)
    const lines = (await readFile(connectTicketsPath(at), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(TICKETS_HELD)
  })

  it('goes in the link’s fragment, which a browser sends nowhere', () => {
    expect(ticketed('http://localhost:7654/connect', 'abc')).toBe(
      'http://localhost:7654/connect#ticket=abc',
    )
  })
})
