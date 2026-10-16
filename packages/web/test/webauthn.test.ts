import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeAll } from '../src/cbor.ts'
import {
  type Algorithm,
  type Credential,
  relyingParty,
  signatureSays,
  userIdOf,
  verifyMade,
  verifyProved,
} from '../src/webauthn.ts'
import { type Ceremony, cbor, FLAGS, SoftAuthenticator } from './authenticator.ts'

// What a passkey's two answers are, and whether one holds: every check in
// `webauthn.ts` as a row with one thing wrong in it, over keys a software
// authenticator makes, and then over answers real authenticators gave.

const RP = 'tade.example.com'
const ORIGIN = `https://${RP}`
const DEVICE = '00112233445566aa'

function ceremony(over: Partial<Ceremony> = {}): Ceremony {
  return { challenge: randomBytes(32).toString('base64url'), origin: ORIGIN, rpId: RP, ...over }
}

const expected = (one: Ceremony) => ({ challenge: one.challenge, origin: ORIGIN, rpId: RP })

/** A passkey made and kept, the way `passkeyed.ts` keeps one. */
function made(box: SoftAuthenticator): Credential {
  const one = ceremony()
  const got = verifyMade(box.make(one), expected(one))
  if (!got.ok) throw new Error(got.why)
  return got.credential
}

describe('a passkey being made', () => {
  for (const alg of [-7, -8, -257] as Algorithm[]) {
    it(`takes a ${alg} key, keeps it public, and says whether it may leave the device`, () => {
      const box = new SoftAuthenticator(alg)
      const one = ceremony({ flags: FLAGS.UP | FLAGS.UV | FLAGS.BE | FLAGS.BS })
      const got = verifyMade(box.make(one), expected(one))
      expect(got.ok, got.ok ? '' : got.why).toBe(true)
      if (!got.ok) return
      expect(got.credential.alg).toBe(alg)
      expect(got.credential.id).toBe(Buffer.from(box.id).toString('base64url'))
      expect(got.credential.synced).toBe(true)
      expect(got.credential.transports).toEqual(['internal', 'hybrid'])
      // The key kept is the authenticator's public key, as SPKI.
      const kept = createPublicKey({
        key: Buffer.from(got.credential.key, 'base64url'),
        format: 'der',
        type: 'spki',
      })
      expect(kept.equals(box.publicKey)).toBe(true)
    })
  }

  it('says a passkey that stays on its device is not synced', () => {
    const one = ceremony()
    const kept = verifyMade(new SoftAuthenticator().make(one), expected(one))
    expect(kept.ok && kept.credential.synced).toBe(false)
  })

  // Each row is one thing wrong, and each is refused with Tade's own reason.
  const wrong: [string, (one: Ceremony) => Partial<Ceremony>, RegExp][] = [
    ['a challenge this machine did not set', () => ({ challenge: 'x'.repeat(43) }), /challenge/],
    ['another origin', () => ({ origin: 'https://evil.example' }), /origin/],
    ['an origin on another port', () => ({ origin: `${ORIGIN}:8443` }), /origin/],
    ['the other ceremony', () => ({ type: 'webauthn.get' }), /webauthn\.get/],
    ['a frame inside another page', () => ({ client: { crossOrigin: true } }), /another page/],
    ['a top origin at all', () => ({ client: { topOrigin: 'https://x.example' } }), /another page/],
    ['another relying party', () => ({ hashedRpId: 'example.com' }), /another site/],
    ['nobody present', () => ({ flags: FLAGS.UV }), /present/],
    ['a tap and no verification', () => ({ flags: FLAGS.UP }), /verified/],
    [
      'backed up and not able to be',
      () => ({ flags: FLAGS.UP | FLAGS.UV | FLAGS.BS }),
      /contradict/,
    ],
    ['bytes after the data', () => ({ trailing: new Uint8Array([0]) }), /after it/],
    ['another credential id in the body', () => ({ bodyId: new Uint8Array(16) }), /credential id/],
  ]
  for (const [what, change, why] of wrong) {
    it(`refuses ${what}`, () => {
      const one = ceremony()
      const box = new SoftAuthenticator()
      const got = verifyMade(box.make({ ...one, ...change(one) }), expected(one))
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.why).toMatch(why)
    })
  }

  it('refuses a key of a kind it did not ask for, or off its curve, or the wrong size', () => {
    const box = new SoftAuthenticator(-7)
    for (const [cose, why] of [
      [new Map([[3, -35]]), /did not ask for/],
      [new Map([[-1, 2]]), /P-256/],
      [new Map([[-2, new Uint8Array(31)]]), /wrong size/],
      // The right size and not a point on the curve.
      [new Map([[-3, new Uint8Array(32).fill(7)]]), /not a key/],
    ] as const) {
      const one = ceremony()
      const got = verifyMade(box.make(one, { cose: box.cose(cose) }), expected(one))
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.why).toMatch(why)
    }
  })

  it('refuses an RSA key under 2048 bits', () => {
    const box = new SoftAuthenticator(-257)
    const one = ceremony()
    const got = verifyMade(
      box.make(one, { cose: box.cose(new Map([[-1, new Uint8Array(128).fill(1)]])) }),
      expected(one),
    )
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.why).toMatch(/size/)
  })

  it('refuses a body with a field nobody declared, or not base64url', () => {
    const one = ceremony()
    const body = new SoftAuthenticator().make(one)
    expect(verifyMade({ ...body, extra: 1 }, expected(one)).ok).toBe(false)
    expect(verifyMade({ ...body, id: `${body.id}=` }, expected(one)).ok).toBe(false)
    const response = { ...body.response, clientDataJSON: `${body.response.clientDataJSON}!` }
    expect(verifyMade({ ...body, response }, expected(one)).ok).toBe(false)
    expect(verifyMade(null, expected(one)).ok).toBe(false)
  })

  it('reads an attestation statement it does not check, and an object it cannot read is refused', () => {
    const one = ceremony()
    const box = new SoftAuthenticator()
    expect(verifyMade(box.make(one, { fmt: 'packed' }), expected(one)).ok).toBe(true)
    const body = box.make(one)
    const broken = {
      ...body.response,
      attestationObject: Buffer.from([0xa1]).toString('base64url'),
    }
    const got = verifyMade({ ...body, response: broken }, expected(one))
    expect(got.ok).toBe(false)
  })
})

describe('what was made, as bytes nobody should send', () => {
  const refusedFor = (opts: Parameters<SoftAuthenticator['make']>[1], why: RegExp) => {
    const one = ceremony()
    const got = verifyMade(new SoftAuthenticator().make(one, opts), expected(one))
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.why).toMatch(why)
  }

  it('refuses an attestation object that is not a map, has no data or no format', () => {
    refusedFor({ object: (authData) => [authData] }, /not a map/)
    refusedFor({ object: () => new Map([['fmt', 'none']]) }, /no authenticator data/)
    refusedFor({ fmt: 7 }, /no attestation format/)
  })

  it('refuses data with no credential in it, an id of no length, and a key that is not a map', () => {
    refusedFor({ bare: true }, /no credential/)
    refusedFor({ idInData: new Uint8Array() }, /impossible length/)
    refusedFor({ cose: [1, 2] }, /not a map/)
  })

  it('refuses client data that is not JSON, or not an object', () => {
    refusedFor({ clientData: Buffer.from('{not json') }, /not JSON/)
    refusedFor({ clientData: Buffer.from('123') }, /not an object/)
  })

  it('reads past extension outputs after the key, which an authenticator may write', () => {
    const one = ceremony()
    const box = new SoftAuthenticator()
    const got = verifyMade(
      box.make(one, { extensions: new Map([['credProtect', 2]]) }),
      expected(one),
    )
    expect(got.ok, got.ok ? '' : got.why).toBe(true)
  })

  it('refuses an Ed25519 key on another curve or of another size, and an RSA key that is not one', () => {
    const ed = new SoftAuthenticator(-8)
    refusedFor({ cose: ed.cose(new Map([[-1, 4]])) }, /not Ed25519/)
    refusedFor({ cose: ed.cose(new Map([[-2, new Uint8Array(31)]])) }, /wrong size/)
    const rsa = new SoftAuthenticator(-257)
    refusedFor({ cose: rsa.cose(new Map([[1, 2]])) }, /not RSA/)
  })
})

describe('a passkey being used', () => {
  it('holds for the credential this device made, under each kind of key', () => {
    for (const alg of [-7, -8, -257] as Algorithm[]) {
      const box = new SoftAuthenticator(alg)
      const credential = made(box)
      const one = ceremony()
      const got = verifyProved(box.prove(one, { userHandle: userIdOf(DEVICE) }), {
        ...expected(one),
        credential,
        device: DEVICE,
      })
      expect(got, String(alg)).toEqual({ ok: true, counter: 0 })
    }
  })

  const used = (box: SoftAuthenticator, credential: Credential, one: Ceremony, opts = {}) =>
    verifyProved(box.prove(one, opts), { ...expected(one), credential, device: DEVICE })

  it('refuses another key signing, another passkey, and another device’s', () => {
    const box = new SoftAuthenticator()
    const credential = made(box)
    const other = new SoftAuthenticator()
    expect(used(box, credential, ceremony(), { signer: other }).ok).toBe(false)
    expect(used(other, credential, ceremony()).ok).toBe(false)
    const theirs = used(box, credential, ceremony(), { userHandle: userIdOf('ffeeddccbbaa9988') })
    expect(theirs.ok).toBe(false)
    expect(used(box, credential, ceremony(), { signature: new Uint8Array(70) }).ok).toBe(false)
  })

  const wrong: [string, Partial<Ceremony>, RegExp][] = [
    ['another origin', { origin: 'https://evil.example' }, /origin/],
    ['the other ceremony', { type: 'webauthn.create' }, /webauthn\.create/],
    ['another relying party', { hashedRpId: 'evil.example' }, /another site/],
    ['nobody present', { flags: FLAGS.UV }, /present/],
    ['a tap and no verification', { flags: FLAGS.UP }, /verified/],
    ['a credential where none belongs', { flags: FLAGS.UP | FLAGS.UV | FLAGS.AT }, /./],
    ['a frame inside another page', { client: { crossOrigin: true } }, /another page/],
  ]
  for (const [what, change, why] of wrong) {
    it(`refuses ${what}`, () => {
      const box = new SoftAuthenticator()
      const credential = made(box)
      const got = used(box, credential, ceremony(change))
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.why).toMatch(why)
    })
  }

  it('refuses a body that is not an answer, data too short, and a credential where none belongs', () => {
    const box = new SoftAuthenticator()
    const credential = made(box)
    const one = ceremony()
    const want = { ...expected(one), credential, device: DEVICE }
    expect(verifyProved({ id: 'x' }, want)).toEqual({ ok: false, why: 'not a passkey being used' })
    const short = verifyProved(box.prove(one, { authData: new Uint8Array(30) }), want)
    expect(!short.ok && short.why).toMatch(/shorter than 37 bytes/)
    // What making it signed, used again as though it were a use of it.
    const making = box.make(one)
    const object = decodeAll(Buffer.from(making.response.attestationObject, 'base64url'))
    const authData = (object as Map<string, Uint8Array>).get('authData')
    const replayed = verifyProved(box.prove(one, { authData }), want)
    expect(replayed).toEqual({ ok: false, why: 'a credential where none belongs' })
  })

  it('refuses a kept key that cannot be read, and says why', () => {
    const box = new SoftAuthenticator()
    const one = ceremony()
    const got = verifyProved(box.prove(one), {
      ...expected(one),
      credential: { ...made(box), key: 'AAAA' },
      device: DEVICE,
    })
    expect(!got.ok && got.why).toMatch(/^a kept key that cannot be read \(/)
  })

  it('says a signature node:crypto cannot even read is one that cannot be read', () => {
    // An RSA padding asked of an Ed25519 key is a question node:crypto refuses.
    const ed = new SoftAuthenticator(-8)
    expect(signatureSays(-257, ed.publicKey, new Uint8Array(8), new Uint8Array(64))).toMatch(
      /^a signature that cannot be read \(/,
    )
  })

  it('refuses a challenge it was not set', () => {
    const box = new SoftAuthenticator()
    const credential = made(box)
    const one = ceremony()
    const got = verifyProved(box.prove(one), {
      ...expected(ceremony()),
      credential,
      device: DEVICE,
    })
    expect(got).toEqual({ ok: false, why: 'a challenge this machine did not set' })
  })

  it('takes a counter that counts up, and refuses one that went back or stood still', () => {
    const box = new SoftAuthenticator(-7)
    const credential = { ...made(box), counter: 5 }
    expect(used(box, credential, ceremony({ counter: 6 }))).toEqual({ ok: true, counter: 6 })
    expect(used(box, credential, ceremony({ counter: 5 })).ok).toBe(false)
    expect(used(box, credential, ceremony({ counter: 2 })).ok).toBe(false)
    // Nought to nought is a synced passkey, which never counts.
    expect(used(box, { ...credential, counter: 0 }, ceremony({ counter: 0 })).ok).toBe(true)
  })
})

describe('answers real authenticators gave', () => {
  // From SimpleWebAuthn's own test suite (MIT, github.com/MasterKale/SimpleWebAuthn,
  // `verifyRegistrationResponse.test.ts` and `verifyAuthenticationResponse.test.ts`):
  // what Firefox on Android and a security key actually sent, so the bytes
  // read here are an authenticator's and not this file's own CBOR.
  const RP_REAL = 'dev.dontneeda.pw'
  const challengeOf = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

  it('takes Firefox on Android’s passkey, made with no attestation', () => {
    const got = verifyMade(
      {
        id: 'AdKXJEch1aV5Wo7bj7qLHskVY4OoNaj9qu8TPdJ7kSAgUeRxWNngXlcNIGt4gexZGKVGcqZpqqWordXb_he1izY',
        type: 'public-key',
        response: {
          attestationObject:
            'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjFPdxHEOnAiLIp26idVjIguzn3I' +
            'pr_RlsKZWsa-5qK-KBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAQQHSlyRHIdWleVqO24-6ix7JFWODqDWo_arvEz3Se' +
            '5EgIFHkcVjZ4F5XDSBreIHsWRilRnKmaaqlqK3V2_4XtYs2pQECAyYgASFYID5PQTZQQg6haZFQWFzqfAOyQ_ENs' +
            'MH8xxQ4GRiNPsqrIlggU8IVUOV8qpgk_Jh-OTaLuZL52KdX1fTht07X4DiQPow',
          clientDataJSON:
            'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiYUVWalkxQlhkWHBw' +
            'VURBd1NEQndOV2Q0YURKZmRUVmZVRU0wVG1WWloyUSIsIm9yaWdpbiI6Imh0dHBzOlwvXC9kZXYuZG9udG5lZWRh' +
            'LnB3IiwiYW5kcm9pZFBhY2thZ2VOYW1lIjoib3JnLm1vemlsbGEuZmlyZWZveCJ9',
          transports: [],
        },
      },
      {
        challenge: challengeOf('hEccPWuziP00H0p5gxh2_u5_PC4NeYgd'),
        origin: `https://${RP_REAL}`,
        rpId: RP_REAL,
      },
    )
    expect(got.ok, got.ok ? '' : got.why).toBe(true)
    if (got.ok) {
      expect(got.credential.alg).toBe(-7)
      expect(got.credential.counter).toBe(0)
    }
  })

  it('takes an RSA key made with no attestation', () => {
    const got = verifyMade(
      {
        id: 'kGXv4RJWLeXRw8Yf3T22K3Gq_GGeDv9OKYmAHLm0Ylo',
        type: 'public-key',
        response: {
          attestationObject:
            'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVkBZz3cRxDpwIiyKduonVYyILs59yKa_0ZbCmVrGvuaivigRQAAAABgKLAXsdRMArSzr82vyWuyACCQZe_hElYt5dHDxh_dPbYrcar8YZ4O_04piYAcubRiWqQBAwM5AQAgWQEA8X6V649G2vwB99CSf_luwR0jj7oDg_GhA3TQSnNYIwfQJldxT5dmi9H8IjjCrTP28iNuKl29hc3Mowux1FZB0bc5AEJ2oV3JCOMGP9NZKGmOosF7iBN2GtGY7Nomcs-ruBv2mxp1nTm6mv5B8XNwh0e18uTA5AJCsl-k6lNLYB2XBIQ3fy2-TjSQ8IOMLypWQbWWBJXzLmepaJ6EWe6kf_NaxpA2chWsaekZcr8xG6OIo3iGh0Mpags_qBZtN4n2TDn0R2LheLk4yQ0R_oOAVtX963Yuw0x5NYSZyMNSMi_1RSEPTYn5AILmIzQskglDaWJYtnjKz4QLuXWCRRYyDSFDAQAB',
          clientDataJSON:
            'eyJjaGFsbGVuZ2UiOiJwWVozVlgyeWI4ZFM5eXBsTnhKQ2hpWGhQR0JrOGdaelRBeUoyaVU1eDFrIiwiY2xpZW50RXh0ZW5zaW9ucyI6e30sImhhc2hBbGdvcml0aG0iOiJTSEEtMjU2Iiwib3JpZ2luIjoiaHR0cHM6Ly9kZXYuZG9udG5lZWRhLnB3IiwidHlwZSI6IndlYmF1dGhuLmNyZWF0ZSJ9',
          transports: [],
        },
      },
      {
        challenge: 'pYZ3VX2yb8dS9yplNxJChiXhPGBk8gZzTAyJ2iU5x1k',
        origin: `https://${RP_REAL}`,
        rpId: RP_REAL,
      },
    )
    expect(got.ok, got.ok ? '' : got.why).toBe(true)
    if (got.ok) expect(got.credential.alg).toBe(-257)
  })

  it('reads past a packed attestation statement it does not check', () => {
    // The body's own `id` was `bbb` in the original, which the check that the
    // body names the credential it carries would refuse; it is the
    // credential's real id here, and nothing signed covers it.
    const got = verifyMade(
      {
        id: 'AYThY1csINY4JrbHyGmqTl1nL_F1zjAF3hSAIngz8kAcjugmAMNVvxZRwqpEH-bNHHAIv291OX5ko9eDf_5mu3UB2BvsScr2K-ppM4owOpGsqwg5tZglqqmxIm1Q',
        type: 'public-key',
        response: {
          attestationObject:
            'o2NmbXRmcGFja2VkZ2F0dFN0bXSiY2FsZyZjc2lnWEcwRQIhANvrPZMUFrl_rvlgR' +
            'qz6lCPlF6B4y885FYUCCrhrzAYXAiAb4dQKXbP3IimsTTadkwXQlrRVdxzlbmPXt847-Oh6r2hhdXRoRGF0YVjhP' +
            'dxHEOnAiLIp26idVjIguzn3Ipr_RlsKZWsa-5qK-KBFXsOO-a3OAAI1vMYKZIsLJfHwVQMAXQGE4WNXLCDWOCa2x' +
            '8hpqk5dZy_xdc4wBd4UgCJ4M_JAHI7oJgDDVb8WUcKqRB_mzRxwCL9vdTl-ZKPXg3_-Zrt1Adgb7EnK9ivqaTOKM' +
            'DqRrKsIObWYJaqpsSJtUKUBAgMmIAEhWCBKMVVaivqCBpqqAxMjuCo5jMeUdh3jDOC0EF4fLBNNTyJYILc7rqDDe' +
            'X1pwCLrl3ZX7IThrtZNwKQVLQyfHiorqP-n',
          clientDataJSON:
            'eyJjaGFsbGVuZ2UiOiJjelpRU1dKQ2JsQlFibkpIVGxOQ2VFNWtkRVJ5VkRkVmNsWlpT' +
            'a3M1U0UwIiwib3JpZ2luIjoiaHR0cHM6Ly9kZXYuZG9udG5lZWRhLnB3IiwidHlwZSI6IndlYmF1dGhuLmNyZWF0' +
            'ZSJ9',
          transports: [],
        },
      },
      {
        challenge: challengeOf('s6PIbBnPPnrGNSBxNdtDrT7UrVYJK9HM'),
        origin: `https://${RP_REAL}`,
        rpId: RP_REAL,
      },
    )
    expect(got.ok, got.ok ? '' : got.why).toBe(true)
    if (got.ok) expect(got.credential.counter).toBe(1589874425)
  })

  it('checks a real assertion’s signature, and refuses it for the tap it was', () => {
    // A security key's assertion, made with presence and no verification: the
    // signature holds under its key, and the ceremony is still refused,
    // because a tap is not a person.
    const cose = decodeAll(
      Buffer.from(
        'pQECAyYgASFYIIheFp-u6GvFT2LNGovf3ZrT0iFVBsA_76rRysxRG9A1Ilgg8WGeA6hPmnab0HAViUYVRkwTNcN77QBf_RR0dv3lIvQ',
        'base64url',
      ),
    ) as Map<number, Uint8Array>
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(cose.get(-2) ?? []).toString('base64url'),
        y: Buffer.from(cose.get(-3) ?? []).toString('base64url'),
      },
      format: 'jwk',
    })
    const authData = Buffer.from('PdxHEOnAiLIp26idVjIguzn3Ipr_RlsKZWsa-5qK-KABAAAAkA', 'base64url')
    const clientData = Buffer.from(
      'eyJjaGFsbGVuZ2UiOiJkRzkwWVd4c2VWVnVhWEYxWlZaaGJIVmxSWFpsY25sVWFXMWwiLCJj' +
        'bGllbnRFeHRlbnNpb25zIjp7fSwiaGFzaEFsZ29yaXRobSI6IlNIQS0yNTYiLCJvcmlnaW4iOiJodHRwczovL2Rldi5k' +
        'b250bmVlZGEucHciLCJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
      'base64url',
    )
    const signature = Buffer.from(
      'MEUCIQDYXBOpCWSWq2Ll4558GJKD2RoWg958lvJSB_GdeokxogIgWuEVQ7ee6AswQY0OsuQ6y8Ks6jhd45bDx92wjXKs900',
      'base64url',
    )
    const hash = (data: Buffer) => createHash('sha256').update(data).digest()
    const signed = Buffer.concat([authData, hash(clientData)])
    expect(signatureSays(-7, key, signed, signature)).toBeNull()
    expect(signatureSays(-7, key, Buffer.concat([signed, Buffer.from([0])]), signature)).toBe(
      'a signature that does not hold',
    )
    expect(signatureSays(-7, key, signed, new Uint8Array(3))).toMatch(/cannot be read|not hold/)

    const credential: Credential = {
      id: 'KEbWNCc7NgaYnUyrNeFGX9_3Y-8oJ3KwzjnaiD1d1LVTxR7v3CaKfCz2Vy_g_MHSh7yJ8yL0Pxg6jo_o0hYiew',
      key: key.export({ type: 'spki', format: 'der' }).toString('base64url'),
      alg: -7,
      counter: 143,
      synced: false,
      transports: [],
    }
    const got = verifyProved(
      {
        id: credential.id,
        type: 'public-key',
        response: {
          authenticatorData: authData.toString('base64url'),
          clientDataJSON: clientData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      },
      {
        challenge: challengeOf('totallyUniqueValueEveryTime'),
        origin: `https://${RP_REAL}`,
        rpId: RP_REAL,
        credential,
        device: DEVICE,
      },
    )
    expect(got).toEqual({
      ok: false,
      why: 'nobody was verified: a passcode or a face was not asked',
    })
  })
})

describe('a relying party', () => {
  it('is a name, never an address', () => {
    expect(relyingParty('tade.example.com')).toBe(true)
    for (const host of ['', '203.0.113.7', '[::1]', '::1', 'tade.example.com.', 'host:443']) {
      expect(relyingParty(host), host).toBe(false)
    }
  })
})

describe('the CBOR the authenticator writes', () => {
  it('reads back what was written, maps and all', () => {
    const value = new Map<number | string, unknown>([
      [1, 2],
      [-1, new Uint8Array([1, 2, 3])],
      ['fmt', 'none'],
      ['list', [true, false, null, 70000, -300]],
    ])
    expect(decodeAll(cbor(value as never))).toEqual(value)
  })
})
