import { describe, expect, it } from 'vitest'
import { devServerPorts, devServerUrl } from '../src/dev-servers.ts'

describe('devServerPorts', () => {
  it('keeps the ports dev servers are told to use, sorted and each once', () => {
    expect(devServerPorts([5173, 3000, 8080, 3000, 4321, 6006, 8000])).toEqual([
      3000, 4321, 5173, 6006, 8000, 8080,
    ])
  })

  it('leaves out the system’s ports and the ones an OS hands out', () => {
    expect(devServerPorts([22, 80, 443, 1023, 32_768, 49_152, 60_185, 65_535])).toEqual([])
    expect(devServerPorts([1024, 32_767])).toEqual([1024, 32_767])
  })

  it('leaves out what a dev setup listens on and never serves a page from', () => {
    expect(devServerPorts([5432, 6379, 3306, 27_017, 9229, 24_678, 5173])).toEqual([5173])
  })

  it('is nothing for nothing, and for what is not a port', () => {
    expect(devServerPorts([])).toEqual([])
    expect(devServerPorts([Number.NaN, 3000.5, -1])).toEqual([])
  })
})

describe('devServerUrl', () => {
  it('is where a browser on this machine finds it', () => {
    expect(devServerUrl(5173)).toBe('http://localhost:5173')
  })
})
