import { createSocket } from 'node:dgram'
import { type Data, nameBytes, type RecordType, type Rr, TYPES } from '../src/dns.ts'

// A DNS server on loopback that answers from what a test says, so the domain
// look is asked over a real socket and never reaches the network. It reads the
// two bits the look turns on — recursion asked for (a resolver) or not (a
// zone's own server), and checking disabled — so one server can be both.

export interface Asked {
  name: string
  type: RecordType
  recurse: boolean
  unchecked: boolean
}

/** What to answer with; null is not answering at all. */
export interface Served {
  rcode?: number
  authenticated?: boolean
  truncated?: boolean
  answers?: Rr[]
  authority?: Rr[]
  /** Answer first with another id, which the asker must not take. */
  strangerFirst?: boolean
  /** Bytes that are not a reply, before the reply or instead of it. */
  garbage?: 'first' | 'only'
}

export interface DnsServer {
  port: number
  asked: Asked[]
  close(): Promise<void>
}

export async function dnsServer(serve: (asked: Asked) => Served | null): Promise<DnsServer> {
  const socket = createSocket('udp4')
  const asked: Asked[] = []
  socket.on('message', (query, from) => {
    const flags = query.readUInt16BE(2)
    let at = 12
    const labels: string[] = []
    while ((query[at] ?? 0) !== 0) {
      const length = query[at] ?? 0
      labels.push(query.subarray(at + 1, at + 1 + length).toString('ascii'))
      at += 1 + length
    }
    const questionEnd = at + 5
    const type = (Object.entries(TYPES).find(([, n]) => n === query.readUInt16BE(at + 1))?.[0] ??
      'A') as RecordType
    const one: Asked = {
      name: labels.join('.'),
      type,
      recurse: (flags & 0x0100) !== 0,
      unchecked: (flags & 0x0010) !== 0,
    }
    asked.push(one)
    const served = serve(one)
    if (served === null) return
    const reply = encodeReply(query.readUInt16BE(0), query.subarray(12, questionEnd), served)
    const send = (bytes: Buffer) => socket.send(bytes, from.port, from.address)
    if (served.strangerFirst)
      send(
        encodeReply((query.readUInt16BE(0) + 1) & 0xffff, query.subarray(12, questionEnd), served),
      )
    if (served.garbage !== undefined) send(Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9]))
    if (served.garbage !== 'only') send(reply)
  })
  await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done))
  let closed: Promise<void> | null = null
  return {
    port: socket.address().port,
    asked,
    // Once, however many times a test asks: the second close of a socket throws.
    close: () => (closed ??= new Promise((done) => socket.close(() => done()))),
  }
}

function encodeReply(id: number, question: Buffer, served: Served): Buffer {
  const answers = served.answers ?? []
  const authority = served.authority ?? []
  const head = Buffer.alloc(12)
  head.writeUInt16BE(id, 0)
  head.writeUInt16BE(
    0x8000 |
      0x0080 |
      (served.authenticated ? 0x0020 : 0) |
      (served.truncated ? 0x0200 : 0) |
      (served.rcode ?? 0),
    2,
  )
  head.writeUInt16BE(1, 4)
  head.writeUInt16BE(answers.length, 6)
  head.writeUInt16BE(authority.length, 8)
  // The answers' owners point back at the question where they are its name,
  // the way real servers compress them, so reading a pointer is what is tested.
  const asked = question.subarray(0, question.length - 4)
  const record = (rr: Rr) => {
    const owner = nameBytes(rr.name).equals(asked) ? Buffer.from([0xc0, 12]) : nameBytes(rr.name)
    const rdata = rdataOf(rr.data)
    const fixed = Buffer.alloc(10)
    fixed.writeUInt16BE(rr.data.type === 'other' ? 99 : TYPES[rr.data.type], 0)
    fixed.writeUInt16BE(1, 2)
    fixed.writeUInt32BE(rr.ttl, 4)
    fixed.writeUInt16BE(rdata.length, 8)
    return Buffer.concat([owner, fixed, rdata])
  }
  return Buffer.concat([head, question, ...answers.map(record), ...authority.map(record)])
}

function rdataOf(data: Data): Buffer {
  switch (data.type) {
    case 'A':
      return Buffer.from(data.address.split('.').map(Number))
    case 'AAAA':
      return v6(data.address)
    case 'NS':
    case 'CNAME':
      return nameBytes(data.target)
    case 'SOA': {
      const numbers = Buffer.alloc(20)
      numbers.writeUInt32BE(2026101601, 0)
      numbers.writeUInt32BE(data.minimum, 16)
      return Buffer.concat([
        nameBytes('ns1.example.net'),
        nameBytes('hostmaster.example.net'),
        numbers,
      ])
    }
    case 'CAA':
      return Buffer.concat([
        Buffer.from([data.flags, data.tag.length]),
        Buffer.from(data.tag, 'latin1'),
        Buffer.from(data.value, 'latin1'),
      ])
    case 'DS': {
      const fixed = Buffer.alloc(4)
      fixed.writeUInt16BE(data.keyTag, 0)
      fixed[2] = data.algorithm
      fixed[3] = data.digestType
      return Buffer.concat([fixed, Buffer.from(data.digest, 'hex')])
    }
    case 'DNSKEY':
      return data.rdata
    case 'other':
      return Buffer.alloc(0)
  }
}

function v6(address: string): Buffer {
  const [head = '', tail] = address.split('::')
  const front = head === '' ? [] : head.split(':')
  const back = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back]
  const out = Buffer.alloc(16)
  groups.forEach((group, i) => {
    out.writeUInt16BE(Number.parseInt(group, 16), i * 2)
  })
  return out
}

/** A record, as a test writes one. */
export const rr = (name: string, data: Data, ttl = 300): Rr => ({ name, ttl, data })

/** The SOA a negative answer carries: the zone's, with how long "none" is remembered. */
export const soa = (zone: string, minimum = 300, ttl = 3600): Rr =>
  rr(zone, { type: 'SOA', minimum }, ttl)
