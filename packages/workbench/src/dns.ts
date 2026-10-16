import { createHash, randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIPv6 } from 'node:net'
import type { DelegationSigner } from '@tade/core'

// DNS, asked directly: one question to one server over UDP, and the parts of
// the reply the domain look reads (`domain.ts`).
//
// **Why not `node:dns`.** It cannot set the two bits the look turns on —
// recursion off, to ask a zone's own servers what is true now, and checking
// disabled, to reach a zone whose DNSSEC is broken — and it hands back neither
// the response code, nor a validating resolver's authenticated-data bit, nor
// the SOA a negative answer carries, which is how long "there is none" is
// remembered. Those are the difference between missing, wrong and not yet
// visible.
//
// Every ask has a deadline, and a reply that is not to the question asked —
// another id, another name or type — is not read.

export const TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  AAAA: 28,
  DS: 43,
  DNSKEY: 48,
  CAA: 257,
} as const
export type RecordType = keyof typeof TYPES

/** Response codes the look tells apart. */
export const NOERROR = 0
export const SERVFAIL = 2
export const NXDOMAIN = 3

export interface Question {
  name: string
  type: RecordType
  /** Ask the server to resolve it: a resolver. Off for a zone's own servers. */
  recurse: boolean
  /** Checking disabled: a validating resolver answers even where DNSSEC fails. */
  unchecked?: boolean
}

export type Data =
  | { type: 'A' | 'AAAA'; address: string }
  | { type: 'NS' | 'CNAME'; target: string }
  | { type: 'SOA'; minimum: number }
  | { type: 'CAA'; flags: number; tag: string; value: string }
  | ({ type: 'DS' } & DelegationSigner)
  | { type: 'DNSKEY'; flags: number; algorithm: number; rdata: Buffer }
  | { type: 'other' }

/** One record of a reply. Names are lower case, without the final dot. */
export interface Rr {
  name: string
  ttl: number
  data: Data
}

export interface Reply {
  rcode: number
  /** A validating resolver's word that what it answered checked out (AD). */
  authenticated: boolean
  truncated: boolean
  answers: Rr[]
  authority: Rr[]
}

export interface AskOptions {
  port?: number
  /** How long each try waits. */
  ms?: number
  tries?: number
}

/** One try's deadline, and how many tries: a lost datagram is the commonest failure there is. */
export const ASK_MS = 1_500
export const ASK_TRIES = 2

/** Ask `server` one question. Never throws: no answer is an answer, with why. */
export async function ask(
  server: string,
  question: Question,
  opts: AskOptions = {},
): Promise<Reply | { cannot: string }> {
  let last = 'no answer'
  for (let i = 0; i < (opts.tries ?? ASK_TRIES); i++) {
    const got = await once(server, question, opts)
    if (!('cannot' in got)) return got
    last = got.cannot
  }
  return { cannot: last }
}

function once(
  server: string,
  question: Question,
  opts: AskOptions,
): Promise<Reply | { cannot: string }> {
  const ms = opts.ms ?? ASK_MS
  const id = randomInt(0, 0x10000)
  const socket = createSocket(isIPv6(server) ? 'udp6' : 'udp4')
  return new Promise((done) => {
    let settled = false
    const answer = (got: Reply | { cannot: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      done(got)
    }
    // What came back that could not be read: not the reply to this question,
    // and said with the timeout, because "no answer" from a server that
    // answered in bytes nobody could read would be the wrong thing to say.
    let unread = ''
    const timer = setTimeout(
      () => answer({ cannot: `no answer from ${server} in ${ms / 1000} s${unread}` }),
      ms,
    )
    socket.on('error', (err: NodeJS.ErrnoException) => answer({ cannot: err.code ?? err.message }))
    socket.on('message', (message) => {
      let reply: ReturnType<typeof decodeReply>
      try {
        reply = decodeReply(message)
      } catch (err) {
        unread = ` that could be read (${err instanceof Error ? err.message : String(err)})`
        return
      }
      if (reply.id !== id || reply.question !== key(question.name, TYPES[question.type])) return
      const { rcode, authenticated, truncated, answers, authority } = reply
      answer({ rcode, authenticated, truncated, answers, authority })
    })
    socket.send(encodeQuery(id, question), opts.port ?? 53, server)
  })
}

function key(name: string, type: number): string {
  return `${bare(name)}/${type}`
}

/** A name as compared: lower case, no final dot. */
function bare(name: string): string {
  return name.toLowerCase().replace(/\.$/, '')
}

/** The question as it goes on the wire, with EDNS for a reply bigger than 512 bytes. */
export function encodeQuery(id: number, question: Question): Buffer {
  // RD asks for recursion; AD in a query asks for the AD bit back (RFC 6840
  // §5.7) without DO, so the reply carries no signatures; CD turns checking off.
  const flags = (question.recurse ? 0x0100 : 0) | 0x0020 | (question.unchecked ? 0x0010 : 0)
  const head = Buffer.alloc(12)
  head.writeUInt16BE(id, 0)
  head.writeUInt16BE(flags, 2)
  head.writeUInt16BE(1, 4)
  head.writeUInt16BE(1, 10)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(TYPES[question.type], 0)
  tail.writeUInt16BE(1, 2)
  // The OPT record: the root, type 41, 1232 bytes — the size every large
  // resolver agreed on in 2020 so a reply is never fragmented.
  const opt = Buffer.from([0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([head, nameBytes(question.name), tail, opt])
}

/** A name in wire form, lower case as DNSSEC's canonical form wants it. */
export function nameBytes(name: string): Buffer {
  const labels = bare(name)
    .split('.')
    .filter((one) => one !== '')
  return Buffer.concat([
    ...labels.map((one) => Buffer.concat([Buffer.from([one.length]), Buffer.from(one, 'ascii')])),
    Buffer.from([0]),
  ])
}

/** A reply, read: throws on bytes that are not one, which `ask` treats as no reply. */
export function decodeReply(buf: Buffer): Reply & { id: number; question: string } {
  const flags = buf.readUInt16BE(2)
  if (buf.readUInt16BE(4) !== 1) throw new Error('not one question')
  let at = 12
  const asked = readName(buf, at)
  const question = key(asked.name, buf.readUInt16BE(asked.next))
  at = asked.next + 4
  const read = (n: number) => {
    const out: Rr[] = []
    for (let i = 0; i < n; i++) {
      const owner = readName(buf, at)
      const type = buf.readUInt16BE(owner.next)
      const ttl = buf.readUInt32BE(owner.next + 4)
      const length = buf.readUInt16BE(owner.next + 8)
      const start = owner.next + 10
      if (start + length > buf.length) throw new Error('a record runs past the end')
      out.push({ name: owner.name, ttl, data: dataOf(buf, type, start, length) })
      at = start + length
    }
    return out
  }
  const answers = read(buf.readUInt16BE(6))
  const authority = read(buf.readUInt16BE(8))
  return {
    id: buf.readUInt16BE(0),
    question,
    rcode: flags & 0x000f,
    authenticated: (flags & 0x0020) !== 0,
    truncated: (flags & 0x0200) !== 0,
    answers,
    authority,
  }
}

function dataOf(buf: Buffer, type: number, at: number, length: number): Data {
  const rdata = buf.subarray(at, at + length)
  switch (type) {
    case TYPES.A:
      return { type: 'A', address: [...rdata].join('.') }
    case TYPES.AAAA:
      return { type: 'AAAA', address: ipv6(rdata) }
    case TYPES.NS:
    case TYPES.CNAME:
      return { type: type === TYPES.NS ? 'NS' : 'CNAME', target: readName(buf, at).name }
    case TYPES.SOA: {
      const mname = readName(buf, at)
      const rname = readName(buf, mname.next)
      return { type: 'SOA', minimum: buf.readUInt32BE(rname.next + 16) }
    }
    case TYPES.CAA: {
      const tagLength = rdata[1] ?? 0
      return {
        type: 'CAA',
        flags: rdata[0] ?? 0,
        tag: rdata.subarray(2, 2 + tagLength).toString('latin1'),
        value: rdata.subarray(2 + tagLength).toString('latin1'),
      }
    }
    case TYPES.DS:
      return {
        type: 'DS',
        keyTag: rdata.readUInt16BE(0),
        algorithm: rdata[2] ?? 0,
        digestType: rdata[3] ?? 0,
        digest: rdata.subarray(4).toString('hex').toUpperCase(),
      }
    case TYPES.DNSKEY:
      return {
        type: 'DNSKEY',
        flags: rdata.readUInt16BE(0),
        algorithm: rdata[3] ?? 0,
        rdata: Buffer.from(rdata),
      }
    default:
      return { type: 'other' }
  }
}

/** A name at `at`, following compression pointers, and where what follows it starts. */
function readName(buf: Buffer, at: number): { name: string; next: number } {
  const labels: string[] = []
  let next = -1
  let jumps = 0
  for (;;) {
    const length = buf[at]
    if (length === undefined) throw new Error('a name runs past the end')
    if (length === 0) {
      if (next < 0) next = at + 1
      break
    }
    if ((length & 0xc0) === 0xc0) {
      if (++jumps > 32) throw new Error('a name that points at itself')
      if (next < 0) next = at + 2
      at = ((length & 0x3f) << 8) | (buf[at + 1] ?? 0)
      continue
    }
    labels.push(buf.subarray(at + 1, at + 1 + length).toString('latin1'))
    at += 1 + length
  }
  return { name: bare(labels.join('.')), next }
}

/** An IPv6 address as text, compressed the way the URL standard and `os.networkInterfaces()` both do. */
export function ipv6(bytes: Uint8Array): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2)
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16))
  return canonical6(groups.join(':'))
}

/** One spelling of an IPv6 address, so two can be compared as text. */
export function canonical6(address: string): string {
  const bare = address.replace(/%.*$/, '')
  if (!isIPv6(bare)) return address.toLowerCase()
  return new URL(`http://[${bare}]/`).hostname.slice(1, -1)
}

/** A DNSKEY's key tag (RFC 4034 appendix B). */
export function keyTag(rdata: Uint8Array): number {
  let sum = 0
  rdata.forEach((byte, i) => {
    sum += i & 1 ? byte : byte << 8
  })
  sum += (sum >> 16) & 0xffff
  return sum & 0xffff
}

/** The DS record, SHA-256, that a DNSKEY at `owner` needs at the registrar (RFC 4509). */
export function dsOf(owner: string, rdata: Buffer, algorithm: number): DelegationSigner {
  return {
    keyTag: keyTag(rdata),
    algorithm,
    digestType: 2,
    digest: createHash('sha256')
      .update(Buffer.concat([nameBytes(owner), rdata]))
      .digest('hex')
      .toUpperCase(),
  }
}
