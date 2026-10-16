// The part of CBOR (RFC 8949) a passkey arrives in: an attestation object, the
// credential's public key, and nothing else.
//
// Pure, and its own file for the reason `proxy-protocol.ts` is: every malformed
// byte string is a row in `test/cbor.test.ts` rather than a phone somebody had
// to find. `webauthn.ts` reads what this decodes.
//
// **Only the shapes an authenticator writes, and every other one is refused.**
// CTAP2 writes canonical CBOR — definite lengths, integer or text keys — so an
// indefinite length, a float or a reserved value is not something a real
// authenticator sends, and decoding one would only be surface for a crafted
// body to explore. A tag is read through to what it tags, because an
// attestation statement Tade does not check may carry one and refusing the
// whole registration over a part nobody reads would be refusing a real phone.
//
// **Every count is checked against the bytes left before anything is made**, so
// a header claiming four billion entries in a body of forty bytes is a refusal
// on the spot rather than a loop or an allocation, and nesting stops at
// `DEEPEST`. The body is already bounded (`BODY_MAX`); these bound the work.

/** What a decoded item is. A map keeps its keys as decoded, numbers and text alike. */
export type Cbor = number | Uint8Array | string | boolean | null | undefined | Cbor[] | CborMap

export type CborMap = Map<number | string, Cbor>

/** How deep items may nest. An attestation statement is three deep at most. */
export const DEEPEST = 16

/** Why some bytes are not the CBOR this reads. */
export class NotCbor extends Error {}

/** One item off the front of `bytes`, and where it ended. */
export function decodeFirst(bytes: Uint8Array, at = 0): { value: Cbor; end: number } {
  const read = new Reader(bytes, at)
  const value = read.item(0)
  return { value, end: read.at }
}

/** Exactly one item, and nothing after it. */
export function decodeAll(bytes: Uint8Array): Cbor {
  const { value, end } = decodeFirst(bytes)
  if (end !== bytes.length) throw new NotCbor(`${bytes.length - end} byte(s) after the item`)
  return value
}

class Reader {
  readonly bytes: Uint8Array
  at: number

  constructor(bytes: Uint8Array, at: number) {
    this.bytes = bytes
    this.at = at
  }

  item(depth: number): Cbor {
    if (depth > DEEPEST) throw new NotCbor('nested too deep')
    const first = this.byte()
    const major = first >> 5
    const info = first & 0x1f
    if (major === 7) return this.simple(info)
    const n = this.count(info)
    switch (major) {
      case 0:
        return n
      case 1:
        return -1 - n
      case 2:
        return this.take(n)
      case 3:
        return text(this.take(n))
      case 4: {
        this.room(n)
        const out: Cbor[] = []
        for (let i = 0; i < n; i++) out.push(this.item(depth + 1))
        return out
      }
      case 5: {
        // Two bytes at the least for each pair: a key and a value.
        this.room(n * 2)
        const out: CborMap = new Map()
        for (let i = 0; i < n; i++) {
          const key = this.item(depth + 1)
          if (typeof key !== 'number' && typeof key !== 'string') {
            throw new NotCbor('a map key that is neither a number nor text')
          }
          if (out.has(key)) throw new NotCbor('a map key given twice')
          out.set(key, this.item(depth + 1))
        }
        return out
      }
      default:
        // 6, a tag: read through to the item it tags.
        return this.item(depth + 1)
    }
  }

  /** The argument of a header: the value itself, or the bytes after it. */
  private count(info: number): number {
    if (info < 24) return info
    if (info === 24) return this.byte()
    if (info === 25) return this.word16()
    if (info === 26) return this.word16() * 0x10000 + this.word16()
    if (info === 27) {
      const high = this.word16() * 0x10000 + this.word16()
      const low = this.word16() * 0x10000 + this.word16()
      // Past 2^53 a number stops being exact, and no length or counter an
      // authenticator writes is anywhere near it.
      if (high >= 0x200000) throw new NotCbor('a number too large to hold exactly')
      return high * 0x100000000 + low
    }
    throw new NotCbor(info === 31 ? 'an indefinite length' : 'a reserved length')
  }

  private simple(info: number): Cbor {
    if (info === 20) return false
    if (info === 21) return true
    if (info === 22) return null
    if (info === 23) return undefined
    throw new NotCbor(info >= 25 && info <= 27 ? 'a float' : 'a simple value nobody writes')
  }

  private word16(): number {
    return this.byte() * 0x100 + this.byte()
  }

  private byte(): number {
    const value = this.bytes[this.at]
    if (value === undefined) throw new NotCbor('it ends in the middle of an item')
    this.at++
    return value
  }

  private room(n: number): void {
    if (n > this.bytes.length - this.at) throw new NotCbor('a count longer than what is left')
  }

  private take(n: number): Uint8Array {
    this.room(n)
    const out = this.bytes.slice(this.at, this.at + n)
    this.at += n
    return out
  }
}

/** UTF-8, and a byte sequence that is not UTF-8 is not text. */
function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new NotCbor('text that is not UTF-8')
  }
}
