import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { CONNECT_OFF, CONNECT_ON_LAN, connectWhere } from '../src/connect-where.ts'
import { surfaceOf } from '../src/surface.ts'

// Where the guided pages that connect a source answer: the one answer `tade
// web connect` prints and Settings › Intake draws. They are `here` routes, so
// only this machine's own loopback door is ever an address for them.

const surface = (web: Record<string, unknown>) =>
  surfaceOf(ConfigSchema.parse({ surfaces: { web } }).surfaces.web)

describe('where the connect pages answer', () => {
  it('is this machine’s own door, whatever public name it has', () => {
    const where = connectWhere(surface({ enabled: true, port: 7711, public: 'tade.example.com' }))
    expect(where).toEqual({
      url: 'http://localhost:7711/connect',
      how: 'here, or from another machine through `ssh -L 7711:localhost:7711`',
    })
  })

  it('is nowhere while the away view is off, and says what turns it on', () => {
    expect(connectWhere(surface({ enabled: false }))).toEqual({ url: null, why: CONNECT_OFF })
  })

  it('is nowhere on a lan bind, where no listener is this machine', () => {
    expect(connectWhere(surface({ enabled: true, bind: 'lan' }))).toEqual({
      url: null,
      why: CONNECT_ON_LAN,
    })
  })

  it('is nowhere while the door is not up, rather than a link to a page that will not open', () => {
    const where = connectWhere(surface({ enabled: true, port: 7711 }), false)
    expect(where.url).toBeNull()
    expect('why' in where ? where.why : '').toContain('nothing is listening on port 7711 here')
  })
})
