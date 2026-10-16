import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import type { Algorithm } from '../src/webauthn.ts'

// A software authenticator: real keys, real signatures, real CBOR — and every
// field a knob, so each check `webauthn.ts` makes is a row with one thing
// wrong in it. What it cannot be is a real phone; the answers real
// authenticators gave are `webauthn.test.ts`'s other half, and Chromium's own
// virtual authenticator drove the page end to end (the V5 commit says how).

/** A CBOR value, as this writes one. */
export type Cbor =
  | number
  | Uint8Array
  | string
  | boolean
  | null
  | Cbor[]
  | Map<number | string, Cbor>

/** Canonical CBOR, definite lengths, as CTAP2 writes it. */
export function cbor(value: Cbor): Uint8Array {
  const out: number[] = []
  const head = (major: number, n: number): void => {
    if (n < 24) out.push((major << 5) | n)
    else if (n < 0x100) out.push((major << 5) | 24, n)
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff)
    else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
  }
  const write = (one: Cbor): void => {
    if (typeof one === 'number') {
      if (one >= 0) head(0, one)
      else head(1, -1 - one)
    } else if (one instanceof Uint8Array) {
      head(2, one.length)
      out.push(...one)
    } else if (typeof one === 'string') {
      const bytes = Buffer.from(one, 'utf8')
      head(3, bytes.length)
      out.push(...bytes)
    } else if (one === false) out.push(0xf4)
    else if (one === true) out.push(0xf5)
    else if (one === null) out.push(0xf6)
    else if (Array.isArray(one)) {
      head(4, one.length)
      for (const item of one) write(item)
    } else {
      head(5, one.size)
      for (const [key, item] of one) {
        write(key)
        write(item)
      }
    }
  }
  write(value)
  return new Uint8Array(out)
}

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40
const ED = 0x80

const b64 = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest()

/** What a ceremony is about, and every way one of its answers can be wrong. */
export interface Ceremony {
  challenge: string
  origin: string
  rpId: string
  /** The client data's `type`, where a test wants the wrong one. */
  type?: string
  /** Extra client-data members: `crossOrigin`, `topOrigin`. */
  client?: Record<string, unknown>
  /** The flags byte; UP and UV by default. */
  flags?: number
  /** The counter the authenticator reports, where a test wants one. */
  counter?: number
  /** The relying party hashed into the data, where a test wants another. */
  hashedRpId?: string
  /** The id the body names, where a test wants it to differ from the credential's. */
  bodyId?: Uint8Array
  /** Bytes after the authenticator data, which no authenticator writes. */
  trailing?: Uint8Array
}

/** A passkey in a box. */
export class SoftAuthenticator {
  readonly alg: Algorithm
  readonly id: Uint8Array
  private readonly key: KeyObject
  readonly publicKey: KeyObject
  counter: number

  constructor(alg: Algorithm = -7, opts: { counter?: number; id?: Uint8Array } = {}) {
    this.alg = alg
    this.id = opts.id ?? new Uint8Array(randomBytes(32))
    this.counter = opts.counter ?? 0
    const pair =
      alg === -7
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : alg === -8
          ? generateKeyPairSync('ed25519')
          : generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.key = pair.privateKey
    this.publicKey = pair.publicKey
  }

  /** Its public key as COSE (RFC 9053), with any field a test wants changed. */
  cose(over: Map<number, Cbor> = new Map()): Map<number, Cbor> {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>
    const bytes = (field: string) => new Uint8Array(Buffer.from(jwk[field] ?? '', 'base64url'))
    const out = new Map<number, Cbor>()
    if (this.alg === -7) {
      out.set(1, 2).set(3, -7).set(-1, 1).set(-2, bytes('x')).set(-3, bytes('y'))
    } else if (this.alg === -8) {
      out.set(1, 1).set(3, -8).set(-1, 6).set(-2, bytes('x'))
    } else {
      out.set(1, 3).set(3, -257).set(-1, bytes('n')).set(-2, bytes('e'))
    }
    for (const [field, value] of over) out.set(field, value)
    return out
  }

  /** What `navigator.credentials.create()` would answer, as the page sends it. */
  make(
    ceremony: Ceremony,
    opts: {
      cose?: Cbor
      fmt?: Cbor
      /** The credential's id as the data carries it, where a test wants another length. */
      idInData?: Uint8Array
      /** No credential in the data at all, and no AT flag. */
      bare?: boolean
      /** Extension outputs after the key, with the ED flag. */
      extensions?: Cbor
      /** The whole attestation object, made from the data, where a test wants another. */
      object?: (authData: Uint8Array) => Cbor
      clientData?: Uint8Array
    } = {},
  ) {
    const id = opts.idInData ?? this.id
    const extensions = opts.extensions === undefined ? new Uint8Array() : cbor(opts.extensions)
    const authData = this.authData(
      ceremony,
      (opts.bare === true ? 0 : AT) | (opts.extensions === undefined ? 0 : ED),
      () => {
        if (opts.bare === true) return extensions
        const length = new Uint8Array([id.length >> 8, id.length & 0xff])
        return Buffer.concat([
          new Uint8Array(16),
          length,
          id,
          cbor(opts.cose ?? this.cose()),
          extensions,
        ])
      },
    )
    const attestation =
      opts.object?.(authData) ??
      new Map<string, Cbor>([
        ['fmt', opts.fmt ?? 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    return {
      id: b64(ceremony.bodyId ?? this.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64(opts.clientData ?? this.clientData(ceremony, 'webauthn.create')),
        attestationObject: b64(cbor(attestation)),
        transports: ['internal', 'hybrid'],
      },
    }
  }

  /** What `navigator.credentials.get()` would answer, as the page sends it. */
  prove(
    ceremony: Ceremony,
    opts: {
      userHandle?: string | null
      signer?: SoftAuthenticator
      signature?: Uint8Array
      /** The authenticator data, where a test wants other bytes signed and sent. */
      authData?: Uint8Array
      clientData?: Uint8Array
    } = {},
  ) {
    const authData = opts.authData ?? this.authData(ceremony, 0, () => new Uint8Array())
    const client = opts.clientData ?? this.clientData(ceremony, 'webauthn.get')
    const signed = Buffer.concat([authData, sha256(client)])
    const signature = opts.signature ?? (opts.signer ?? this).sign(signed)
    return {
      id: b64(ceremony.bodyId ?? this.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64(client),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: opts.userHandle === undefined ? null : opts.userHandle,
      },
    }
  }

  sign(data: Uint8Array): Uint8Array {
    if (this.alg === -8) return sign(null, data, this.key)
    if (this.alg === -7) return sign('sha256', data, { key: this.key, dsaEncoding: 'der' })
    return sign('sha256', data, this.key)
  }

  private clientData(ceremony: Ceremony, type: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: ceremony.type ?? type,
        challenge: ceremony.challenge,
        origin: ceremony.origin,
        crossOrigin: false,
        ...ceremony.client,
      }),
      'utf8',
    )
  }

  private authData(ceremony: Ceremony, extra: number, rest: () => Uint8Array): Buffer {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(ceremony.counter ?? this.counter)
    return Buffer.concat([
      sha256(ceremony.hashedRpId ?? ceremony.rpId),
      new Uint8Array([(ceremony.flags ?? UP | UV) | extra]),
      counter,
      rest(),
      ceremony.trailing ?? new Uint8Array(),
    ])
  }
}

export const FLAGS = { UP, UV, BE, BS, AT, ED }
