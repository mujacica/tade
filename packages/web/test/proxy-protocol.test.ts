import { describe, expect, it } from 'vitest'
import { readProxyHeader, V2_MOST } from '../src/proxy-protocol.ts'

// What the bytes at the front of a public connection are. Caddy's own bytes
// (2.11.7, `proxy_protocol v1` and `v2` over a `unix//` upstream) are the first
// rows, copied from what it sent a socket in a container; the rest are what a
// reader of this format gets wrong.

const SIG = Buffer.from('0d0a0d0a000d0a515549540a', 'hex')

/** A version 2 header: the command, the family byte, and what follows. */
function v2(command: number, family: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head[0] = 0x20 | command
  head[1] = family
  head.writeUInt16BE(body.length, 2)
  return Buffer.concat([SIG, head, body])
}

const REQUEST = Buffer.from('GET / HTTP/1.1\r\nHost: tade.example.com\r\n\r\n', 'latin1')

describe('what Caddy sends', () => {
  it('reads its version 2 header, and leaves the request after it', () => {
    // conn 1 of the probe: 127.0.0.1 to 0.0.0.0, ports 0 — Caddy carries no port.
    const caddy = Buffer.from('0d0a0d0a000d0a515549540a2111000c7f0000010000000000000000', 'hex')
    const bytes = Buffer.concat([caddy, REQUEST])
    expect(readProxyHeader(bytes)).toEqual({ kind: 'header', from: '127.0.0.1', length: 28 })
    expect(bytes.subarray(28).equals(REQUEST)).toBe(true)
  })

  it('reads its version 1 header', () => {
    const bytes = Buffer.concat([Buffer.from('PROXY TCP4 127.0.0.1 0.0.0.0 0 0\r\n'), REQUEST])
    expect(readProxyHeader(bytes)).toEqual({ kind: 'header', from: '127.0.0.1', length: 34 })
  })

  it('reads an IPv6 client in the spelling Node gives a socket', () => {
    const body = Buffer.alloc(36)
    Buffer.from('20010db8000000000000000000000001', 'hex').copy(body)
    expect(readProxyHeader(v2(1, 0x21, body))).toMatchObject({ from: '2001:db8::1' })
    expect(readProxyHeader(Buffer.from('PROXY TCP6 2001:DB8:0:0:0:0:0:1 ::1 443 80\r\n'))).toEqual({
      kind: 'header',
      from: '2001:db8::1',
      length: 44,
    })
  })

  it('reads a mapped IPv4 client as the IPv4 it is, so one phone is one key', () => {
    const body = Buffer.alloc(36)
    Buffer.from('00000000000000000000ffffcb007107', 'hex').copy(body)
    expect(readProxyHeader(v2(1, 0x21, body))).toMatchObject({ from: '203.0.113.7' })
  })
})

describe('no header', () => {
  it('is the request itself, decided on the first byte that cannot be one', () => {
    for (const start of ['GET / HTTP/1.1\r\n', 'POST /api/pair', 'PUT', 'PATCH', '\r\nGET /'])
      expect(readProxyHeader(Buffer.from(start)), start).toEqual({ kind: 'none' })
  })

  it('waits while the bytes could still be either', () => {
    for (const start of ['', 'P', 'PROX', 'PROXY', 'PROXY TCP4 1.2.3.4', '\r\n\r\n\0\r\nQU'])
      expect(readProxyHeader(Buffer.from(start, 'latin1')), start).toEqual({ kind: 'more' })
    // The whole signature and part of the rest.
    expect(readProxyHeader(Buffer.concat([SIG, Buffer.from([0x21, 0x11])]))).toEqual({
      kind: 'more',
    })
    // The fixed part, and an address still to come.
    expect(readProxyHeader(v2(1, 0x11, Buffer.alloc(12)).subarray(0, 20))).toEqual({
      kind: 'more',
    })
  })
})

describe('a connection that names nobody', () => {
  it('is a header with no address: LOCAL, UNSPEC, a Unix socket, UNKNOWN', () => {
    expect(readProxyHeader(v2(0, 0x11, Buffer.alloc(12)))).toEqual({
      kind: 'header',
      from: null,
      length: 28,
    })
    expect(readProxyHeader(v2(1, 0x00, Buffer.alloc(0)))).toMatchObject({ from: null })
    expect(readProxyHeader(v2(1, 0x31, Buffer.alloc(216)))).toMatchObject({ from: null })
    expect(readProxyHeader(Buffer.from('PROXY UNKNOWN whatever\r\n'))).toEqual({
      kind: 'header',
      from: null,
      length: 24,
    })
  })
})

describe('what is refused, and the connection with it', () => {
  const bad = (bytes: Buffer) => readProxyHeader(bytes).kind

  it('a version 1 line that is not five fields of addresses and ports', () => {
    for (const line of [
      'PROXY TCP4 1.2.3.4 5.6.7.8 1\r\n',
      'PROXY TCP4 1.2.3.4 5.6.7.8 1 2 3\r\n',
      'PROXY TCP4 1.2.3 5.6.7.8 1 2\r\n',
      // WHATWG's own IPv4 parser takes these, which is why it is not used for one.
      'PROXY TCP4 0x7f.0.0.1 5.6.7.8 1 2\r\n',
      'PROXY TCP4 256.0.0.1 5.6.7.8 1 2\r\n',
      'PROXY TCP4 1.2.3.4 5.6.7.8 65536 2\r\n',
      'PROXY TCP4 1.2.3.4 5.6.7.8 01 2\r\n',
      'PROXY TCP6 1.2.3.4 5.6.7.8 1 2\r\n',
      'PROXY TCP6 ::1] ::1 1 2\r\n',
      'PROXY UDP4 1.2.3.4 5.6.7.8 1 2\r\n',
      'PROXY  TCP4 1.2.3.4 5.6.7.8 1 2\r\n',
    ])
      expect(bad(Buffer.from(line)), line).toBe('bad')
  })

  it('a version 1 line with no end in the 107 bytes the spec allows', () => {
    expect(bad(Buffer.from(`PROXY TCP4 ${'1'.repeat(120)}`))).toBe('bad')
    expect(bad(Buffer.from(`PROXY TCP4 ${'1'.repeat(80)}`))).toBe('more')
  })

  it('a version 2 header of another version, an unknown command, or too short to hold its family', () => {
    const other = v2(1, 0x11, Buffer.alloc(12))
    other[12] = 0x11
    expect(bad(other)).toBe('bad')
    expect(bad(v2(2, 0x11, Buffer.alloc(12)))).toBe('bad')
    expect(bad(v2(1, 0x11, Buffer.alloc(8)))).toBe('bad')
    expect(bad(v2(1, 0x21, Buffer.alloc(12)))).toBe('bad')
  })

  it('a version 2 header longer than this listener reads, before the bytes arrive', () => {
    const head = v2(1, 0x11, Buffer.alloc(12)).subarray(0, 16)
    head.writeUInt16BE(V2_MOST, 14)
    expect(bad(head)).toBe('bad')
  })
})
