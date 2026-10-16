import { describe, expect, it } from 'vitest'
import { DEEPEST, decodeAll, decodeFirst, NotCbor } from '../src/cbor.ts'

// The part of CBOR a passkey arrives in, and every shape a crafted body might
// try instead — each refused before it costs a loop or an allocation.

const bytes = (...values: number[]) => new Uint8Array(values)

describe('what an authenticator writes', () => {
  it('reads numbers at every width, bytes, text, arrays and maps', () => {
    expect(decodeAll(bytes(0x17))).toBe(23)
    expect(decodeAll(bytes(0x18, 0xff))).toBe(255)
    expect(decodeAll(bytes(0x19, 0x01, 0x00))).toBe(256)
    expect(decodeAll(bytes(0x1a, 0x5e, 0xc3, 0x8e, 0xf9))).toBe(1589874425)
    expect(decodeAll(bytes(0x1b, 0, 0, 0, 1, 0, 0, 0, 0))).toBe(2 ** 32)
    expect(decodeAll(bytes(0x26))).toBe(-7)
    expect(decodeAll(bytes(0x39, 0x01, 0x00))).toBe(-257)
    expect(decodeAll(bytes(0x43, 1, 2, 3))).toEqual(new Uint8Array([1, 2, 3]))
    expect(decodeAll(bytes(0x64, 0x6e, 0x6f, 0x6e, 0x65))).toBe('none')
    expect(decodeAll(bytes(0x83, 0xf5, 0xf4, 0xf6))).toEqual([true, false, null])
    expect(decodeAll(bytes(0xf7))).toBeUndefined()
    expect(decodeAll(bytes(0xa1, 0x01, 0x02))).toEqual(new Map([[1, 2]]))
    // A tag is read through to what it tags.
    expect(decodeAll(bytes(0xc2, 0x41, 0x01))).toEqual(new Uint8Array([1]))
  })

  it('says where the first item ended, which is how a key inside other bytes is read', () => {
    expect(decodeFirst(bytes(0x00, 0x18, 0x20, 0x01), 1)).toEqual({ value: 32, end: 3 })
  })
})

describe('what it never writes, refused', () => {
  const refused: [string, Uint8Array][] = [
    ['an indefinite length', bytes(0x5f, 0x41, 0x01, 0xff)],
    ['a float', bytes(0xfa, 0, 0, 0, 0)],
    ['a reserved length', bytes(0x1c)],
    ['a simple value nobody writes', bytes(0xf0)],
    ['a count longer than what is left', bytes(0x5a, 0xff, 0xff, 0xff, 0xff, 0x00)],
    ['an array claiming four billion items', bytes(0x9a, 0xff, 0xff, 0xff, 0xff)],
    ['a map claiming more pairs than bytes', bytes(0xb8, 0xff, 0x01)],
    ['a map key given twice', bytes(0xa2, 0x01, 0x00, 0x01, 0x00)],
    ['a map key that is bytes', bytes(0xa1, 0x41, 0x00, 0x00)],
    ['text that is not UTF-8', bytes(0x62, 0xc3, 0x28)],
    ['a number too large to hold exactly', bytes(0x1b, 0xff, 0, 0, 0, 0, 0, 0, 0)],
    ['an item cut short', bytes(0x19, 0x01)],
    ['bytes after the item', bytes(0x00, 0x00)],
    ['nothing at all', bytes()],
  ]
  for (const [what, input] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => decodeAll(input)).toThrow(NotCbor)
    })
  }

  it(`stops nesting at ${DEEPEST}`, () => {
    const deep = new Uint8Array([...new Array(DEEPEST + 2).fill(0x81), 0x00])
    expect(() => decodeAll(deep)).toThrow(/too deep/)
    const fine = new Uint8Array([...new Array(DEEPEST).fill(0x81), 0x00])
    expect(() => decodeAll(fine)).not.toThrow()
  })
})
