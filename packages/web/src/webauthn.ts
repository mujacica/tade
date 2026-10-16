import { constants, createHash, createPublicKey, type KeyObject, verify } from 'node:crypto'
import { z } from 'zod'
import { type Cbor, type CborMap, decodeAll, decodeFirst, NotCbor } from './cbor.ts'

// What a passkey's two answers are, and whether one holds: the WebAuthn
// relying party's half (Web Authentication Level 3, §7.1 and §7.2), for the
// shapes Tade asks for and nothing else.
//
// **Written here rather than taken from `@simplewebauthn/server`**, which
// REMOTE-TADE.md §4.4 named. That library is good, and ten packages — an X.509
// stack, ASN.1 schemas for Android and post-quantum keys, `reflect-metadata` —
// almost all of it for checking *attestation*: which make of authenticator a
// key came from. Tade asks for none (`attestation: 'none'`) and checks none,
// because a device is let in by a code shown at the machine, not by the make of
// its phone. What is left is three byte layouts, three kinds of key and
// `node:crypto`'s `verify`, which is the cryptography — so the part that has to
// be right is a checklist, and `test/webauthn.test.ts` is that checklist as a
// cross-product, over keys a software authenticator makes and over answers real
// authenticators gave.
//
// **What is checked, of both ceremonies** — each a row of the test:
//
// 1. the client data is JSON of the right `type`, carrying **the challenge
//    this machine set** and **the origin the request came from**, and not made
//    inside another site's frame;
// 2. the authenticator data names **this relying party** (`sha256` of its id),
//    says a person was **present** and **verified** — Face ID, a fingerprint,
//    a passcode, never a tap alone;
// 3. making one: the credential's id is the one the browser said, and its key
//    is one of the three kinds asked for, on its curve, at its size;
// 4. proving one: it is **the credential this device made**, the signature over
//    the authenticator data and the client data's hash holds under its key, and
//    a counter that was counting has not gone backwards.
//
// **What is not checked, said rather than implied:** the attestation statement
// (which make of authenticator — Tade asks for none and a browser that honours
// that sends none), and extensions. A passkey that syncs (iCloud Keychain,
// Google Password Manager) is the person's, not the phone's: any device signed
// into that keychain can make the assertion, and what it still needs is this
// device's session. `PASSKEY_IS_YOURS` says so where it is turned on.

/** The three kinds of key Tade asks for, in its order of preference. COSE's numbers. */
export const ALGORITHMS = [-8, -7, -257] as const
export type Algorithm = (typeof ALGORITHMS)[number]

/** The flags byte of the authenticator data (§6.1). */
const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40
const ED = 0x80

/** The longest credential id the specification allows (§5.8.3). */
export const CREDENTIAL_ID_MOST = 1023

/** The fewest bytes of an RSA modulus Tade takes: 2048 bits. */
const RSA_LEAST = 256

/** What each base64url field may be, decoded, at the most. */
const B64 = /^[A-Za-z0-9_-]*$/

function b64(most: number) {
  return z
    .string()
    .max(Math.ceil((most * 4) / 3))
    .regex(B64)
}

/**
 * What the page sends after `navigator.credentials.create()`. Strict, so a
 * field nobody declared is a refusal, and every value bounded before decoding.
 */
const MadeBody = z.strictObject({
  id: b64(CREDENTIAL_ID_MOST).min(1),
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: b64(4096).min(1),
    attestationObject: b64(16384).min(1),
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
})

/** What the page sends after `navigator.credentials.get()`. */
const ProvedBody = z.strictObject({
  id: b64(CREDENTIAL_ID_MOST).min(1),
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: b64(4096).min(1),
    authenticatorData: b64(4096).min(37),
    signature: b64(1024).min(1),
    userHandle: b64(64).nullable().optional(),
  }),
})

/** What one ceremony has to have been about: what this machine set, and where. */
export interface Expected {
  /** The challenge this machine set, base64url, exactly as it was handed out. */
  challenge: string
  /** The origin the request came from, exactly: `https://tade.example.com`. */
  origin: string
  /** The relying party: the bare host, which a passkey is bound to. */
  rpId: string
}

/** A credential as Tade keeps it: public, and nothing anybody can sign with. */
export interface Credential {
  /** Its id, base64url, as the authenticator gave it. */
  id: string
  /** Its public key, SPKI DER, base64url. */
  key: string
  alg: Algorithm
  /** The signature counter it last reported. Nought for one that does not count. */
  counter: number
  /** Whether the authenticator says it may leave the device (the BE flag): a synced passkey. */
  synced: boolean
  /** How the browser says it can be reached again, as the browser said it. */
  transports: readonly string[]
}

export type Made = { ok: true; credential: Credential } | { ok: false; why: string }
export type Proved = { ok: true; counter: number } | { ok: false; why: string }

/**
 * Whether a host can be a relying party at all: a name, never an address — a
 * browser refuses one (*the effective domain of the document is not a valid
 * domain*). An IPv6 address has a colon, which no name has; an IPv4 one is
 * four numbers.
 */
export function relyingParty(host: string): boolean {
  if (host === '' || host.includes(':') || host.endsWith('.')) return false
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** The bytes of a user's id: the device's own, so each device's passkey is its own. */
export function userIdOf(device: string): string {
  return Buffer.from(device, 'utf8').toString('base64url')
}

/** A newly made credential, checked (§7.1), or why not. */
export function verifyMade(body: unknown, expected: Expected): Made {
  const got = MadeBody.safeParse(body)
  if (!got.success) return { ok: false, why: 'not a passkey being made' }
  const said = clientDataSays(got.data.response.clientDataJSON, 'webauthn.create', expected)
  if (said !== null) return { ok: false, why: said }

  let object: Cbor
  try {
    object = decodeAll(bytesOf(got.data.response.attestationObject))
  } catch (error) {
    return { ok: false, why: `an attestation object that is not one (${whyOf(error)})` }
  }
  if (!(object instanceof Map)) return { ok: false, why: 'an attestation object that is not a map' }
  const authData = object.get('authData')
  if (!(authData instanceof Uint8Array)) return { ok: false, why: 'no authenticator data' }
  if (typeof object.get('fmt') !== 'string') return { ok: false, why: 'no attestation format' }

  let data: AuthData
  try {
    data = authDataOf(authData)
  } catch (error) {
    return { ok: false, why: `authenticator data that is not (${whyOf(error)})` }
  }
  const flagged = flagsSay(data, expected.rpId)
  if (flagged !== null) return { ok: false, why: flagged }
  if (data.attested === null) return { ok: false, why: 'no credential in what was made' }
  if (!sameBytes(data.attested.id, bytesOf(got.data.id))) {
    return { ok: false, why: 'a credential id that is not the one the browser named' }
  }
  const key = keyOf(data.attested.key)
  if (typeof key === 'string') return { ok: false, why: key }
  return {
    ok: true,
    credential: {
      id: Buffer.from(data.attested.id).toString('base64url'),
      key: key.key.export({ type: 'spki', format: 'der' }).toString('base64url'),
      alg: key.alg,
      counter: data.counter,
      synced: (data.flags & BE) !== 0,
      transports: got.data.response.transports ?? [],
    },
  }
}

/** One assertion of a credential this device made, checked (§7.2), or why not. */
export function verifyProved(
  body: unknown,
  expected: Expected & { credential: Credential; device: string },
): Proved {
  const got = ProvedBody.safeParse(body)
  if (!got.success) return { ok: false, why: 'not a passkey being used' }
  const { credential } = expected
  if (!sameBytes(bytesOf(got.data.id), bytesOf(credential.id))) {
    return { ok: false, why: 'a passkey that is not the one this device made' }
  }
  const handle = got.data.response.userHandle
  if (
    handle !== null &&
    handle !== undefined &&
    handle !== '' &&
    handle !== userIdOf(expected.device)
  ) {
    return { ok: false, why: 'a passkey made for another device' }
  }
  const clientData = bytesOf(got.data.response.clientDataJSON)
  const said = clientDataSays(got.data.response.clientDataJSON, 'webauthn.get', expected)
  if (said !== null) return { ok: false, why: said }

  const raw = bytesOf(got.data.response.authenticatorData)
  let data: AuthData
  try {
    data = authDataOf(raw)
  } catch (error) {
    return { ok: false, why: `authenticator data that is not (${whyOf(error)})` }
  }
  const flagged = flagsSay(data, expected.rpId)
  if (flagged !== null) return { ok: false, why: flagged }
  if (data.attested !== null) return { ok: false, why: 'a credential where none belongs' }

  let key: KeyObject
  try {
    key = createPublicKey({ key: bytesOf(credential.key), format: 'der', type: 'spki' })
  } catch (error) {
    return { ok: false, why: `a kept key that cannot be read (${whyOf(error)})` }
  }
  const signedOver = Buffer.concat([raw, createHash('sha256').update(clientData).digest()])
  const signed = signatureSays(
    credential.alg,
    key,
    signedOver,
    bytesOf(got.data.response.signature),
  )
  if (signed !== null) return { ok: false, why: signed }
  // A counter that counts and went backwards is two copies of one key, which
  // the specification leaves to the relying party: refused, because the one
  // thing this proves is that it is still the same authenticator. A synced
  // passkey reports nought every time, and nought to nought is not backwards.
  if ((data.counter !== 0 || credential.counter !== 0) && data.counter <= credential.counter) {
    return { ok: false, why: 'a counter that did not move on: the passkey may have been copied' }
  }
  return { ok: true, counter: data.counter }
}

/** The client data's own words, against what this machine set: null where it holds. */
function clientDataSays(encoded: string, type: string, expected: Expected): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(encoded)))
  } catch (error) {
    return `client data that is not JSON (${whyOf(error)})`
  }
  if (typeof parsed !== 'object' || parsed === null) return 'client data that is not an object'
  const said = parsed as Record<string, unknown>
  if (said.type !== type) return `client data for ${quoted(said.type)}, not ${type}`
  if (said.challenge !== expected.challenge) return 'a challenge this machine did not set'
  if (said.origin !== expected.origin)
    return `an origin that is not this one: ${quoted(said.origin)}`
  // Made in a frame inside somebody else's page, which nothing of Tade's ever
  // is: the page's content policy refuses to be framed at all.
  if (said.crossOrigin === true || said.topOrigin !== undefined) return 'made inside another page'
  return null
}

/** The flags and the relying party: what both ceremonies ask of the authenticator data. */
function flagsSay(data: AuthData, rpId: string): string | null {
  const wanted = createHash('sha256').update(rpId, 'utf8').digest()
  if (!sameBytes(data.rpIdHash, wanted)) return 'a passkey for another site'
  if ((data.flags & UP) === 0) return 'nobody was present'
  if ((data.flags & UV) === 0) return 'nobody was verified: a passcode or a face was not asked'
  // Backed up without being able to be: a flag pair the specification calls
  // invalid, so the authenticator writing it is not one to believe.
  if ((data.flags & BS) !== 0 && (data.flags & BE) === 0) return 'flags that contradict each other'
  return null
}

/** The authenticator data (§6.1), laid out. */
interface AuthData {
  rpIdHash: Uint8Array
  flags: number
  counter: number
  attested: { id: Uint8Array; key: CborMap } | null
}

function authDataOf(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new NotCbor('shorter than 37 bytes')
  const flags = bytes[32] ?? 0
  const counter = Buffer.from(bytes.subarray(33, 37)).readUInt32BE(0)
  let at = 37
  let attested: AuthData['attested'] = null
  if ((flags & AT) !== 0) {
    // Sixteen bytes of AAGUID — which make of authenticator, not read — then
    // the id's length, the id, and the key.
    if (bytes.length < at + 18) throw new NotCbor('it ends inside the credential')
    const length = ((bytes[at + 16] ?? 0) << 8) | (bytes[at + 17] ?? 0)
    at += 18
    if (length === 0 || length > CREDENTIAL_ID_MOST || bytes.length < at + length) {
      throw new NotCbor('a credential id of an impossible length')
    }
    const id = bytes.slice(at, at + length)
    at += length
    const key = decodeFirst(bytes, at)
    if (!(key.value instanceof Map)) throw new NotCbor('a credential key that is not a map')
    attested = { id, key: key.value }
    at = key.end
  }
  if ((flags & ED) !== 0) at = decodeFirst(bytes, at).end
  if (at !== bytes.length) throw new NotCbor(`${bytes.length - at} byte(s) after it`)
  return { rpIdHash: bytes.slice(0, 32), flags, counter, attested }
}

/**
 * A COSE key (RFC 9053) as a key `node:crypto` can verify with, or why not.
 *
 * Through JWK, which is what `createPublicKey` reads coordinates from — and it
 * refuses a point that is not on its curve, which is the check an EC key
 * needs and the one a hand-made SPKI would skip.
 */
function keyOf(cose: CborMap): { key: KeyObject; alg: Algorithm } | string {
  const kty = cose.get(1)
  const alg = cose.get(3)
  const x = cose.get(-2)
  let jwk: Record<string, string>
  if (alg === -7) {
    const y = cose.get(-3)
    if (kty !== 2 || cose.get(-1) !== 1) return 'an ES256 key that is not on P-256'
    if (!sized(x, 32) || !sized(y, 32)) return 'a P-256 key of the wrong size'
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }
  } else if (alg === -8) {
    if (kty !== 1 || cose.get(-1) !== 6) return 'an EdDSA key that is not Ed25519'
    if (!sized(x, 32)) return 'an Ed25519 key of the wrong size'
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(x) }
  } else if (alg === -257) {
    const n = cose.get(-1)
    if (kty !== 3 || !(n instanceof Uint8Array) || !(x instanceof Uint8Array)) {
      return 'an RS256 key that is not RSA'
    }
    if (n.length < RSA_LEAST || n.length > 1024 || x.length === 0 || x.length > 8) {
      return 'an RSA key of a size Tade does not take'
    }
    jwk = { kty: 'RSA', n: b64url(n), e: b64url(x) }
  } else {
    return `a key of a kind Tade did not ask for (${quoted(alg)})`
  }
  try {
    return { key: createPublicKey({ key: jwk, format: 'jwk' }), alg }
  } catch (error) {
    return `a key that is not a key (${whyOf(error)})`
  }
}

/**
 * Whether a signature over `data` holds under `key`, for its algorithm: null
 * where it holds, and why not where it does not. Never throws — a signature
 * `node:crypto` cannot even read is one that does not hold, and says so.
 */
export function signatureSays(
  alg: Algorithm,
  key: KeyObject,
  data: Uint8Array,
  signature: Uint8Array,
): string | null {
  let holds: boolean
  try {
    if (alg === -8) holds = verify(null, data, key, signature)
    // WebAuthn's ECDSA signatures are DER, which is `node:crypto`'s default for
    // an EC key and said anyway, because the other encoding fails silently.
    else if (alg === -7) holds = verify('sha256', data, { key, dsaEncoding: 'der' }, signature)
    else holds = verify('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }, signature)
  } catch (error) {
    return `a signature that cannot be read (${whyOf(error)})`
  }
  return holds ? null : 'a signature that does not hold'
}

/** base64url to bytes. The schemas above have already held it to the alphabet. */
function bytesOf(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

function b64url(bytes: Cbor): string {
  return Buffer.from(bytes as Uint8Array).toString('base64url')
}

function sized(value: Cbor, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b))
}

function quoted(value: unknown): string {
  return JSON.stringify(typeof value === 'string' ? value.slice(0, 80) : (value ?? null)) ?? 'null'
}

function whyOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
