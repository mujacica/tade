import {
  CATALOGUE,
  type CatalogueEntry,
  catalogued,
  declared,
  type ServerSettings,
  workable,
} from '@tade/mcp-core'
import { describe, expect, it } from 'vitest'

// What Tade has been told about, and what is wrong with each of them.
//
// Pure: a table in the config plus the catalogue in, declared servers out.
// Nothing here opens anything, and nothing here is allowed to need a machine.

const catalogue: readonly CatalogueEntry[] = [
  {
    name: 'linear',
    title: 'Linear',
    description: 'Issues in Linear.',
    workflow: ['Ask about an issue by its number.'],
    transport: 'stdio',
    command: 'linear-mcp',
    auth: 'env',
    authName: 'LINEAR_API_KEY',
    variables: ['LINEAR_API_KEY'],
    install: 'npm install --global linear-mcp',
  },
  {
    name: 'remote',
    title: 'Remote',
    description: 'Something already running.',
    workflow: [],
    transport: 'http',
    url: 'https://example.invalid/mcp',
    auth: 'bearer',
    variables: ['REMOTE_TOKEN'],
  },
]

const transports = ['stdio', 'http', 'sse', 'scripted']

const one = (name: string, servers: Record<string, ServerSettings> = {}) => {
  const found = declared({ servers, catalogue, transports }).find(
    (server) => server.declaration.name === name,
  )
  if (!found) throw new Error(`nothing declared for ${name}`)
  return found
}

describe('the catalogue', () => {
  it('lists every server Tade knows about, and turns none of them on', () => {
    for (const server of declared({ catalogue, transports })) {
      expect(server.declaration.enabled, server.declaration.name).toBe(false)
    }
    // Including the real one, which is the whole point: a server is somebody
    // else's code with tools your agents will call.
    for (const server of declared({ transports: ['stdio', 'http', 'sse'] })) {
      expect(server.declaration.enabled, server.declaration.name).toBe(false)
    }
  })

  it('says what each one is for, in whole lines, and never ships a name twice', () => {
    const names = CATALOGUE.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    for (const entry of CATALOGUE) {
      expect(entry.title, entry.name).toBeTruthy()
      expect(entry.description, entry.name).toBeTruthy()
      for (const line of entry.workflow) expect(line.trim(), entry.name).not.toBe('')
      // Nothing here fetches code from the network at every start: what needs
      // a package says the line to run, and a person runs it where they can
      // see it.
      expect(entry.command ?? '', entry.name).not.toMatch(/^(npx|uvx|pipx|bunx|dlx)\b/)
      if (entry.command && !entry.install) throw new Error(`${entry.name} says nothing to install`)
    }
  })

  it('has no filesystem, fetch or git server in it, each for its own reason', () => {
    for (const name of ['filesystem', 'fetch', 'git']) {
      expect(catalogued(name), name).toBeNull()
    }
  })
})

describe('what a person wrote, and what the catalogue fills in', () => {
  it('fills in everything they left out', () => {
    const server = one('linear', { linear: { enabled: true } })
    expect(server.declaration).toMatchObject({
      transport: 'stdio',
      command: 'linear-mcp',
      auth: 'env',
      authName: 'LINEAR_API_KEY',
      install: 'npm install --global linear-mcp',
      enabled: true,
    })
    expect(server.from).toBe('catalogue')
    expect(server.problem).toBeNull()
  })

  it('leaves what they wrote alone, and says which of it is theirs', () => {
    const server = one('linear', { linear: { enabled: true, command: 'my-linear' } })
    expect(server.declaration.command).toBe('my-linear')
    expect(server.from).toBe('both')
    expect(server.yours).toEqual(['command'])
  })

  it('puts the variable they already use in front of the one Tade looks in', () => {
    expect(one('linear', { linear: { key_env: 'WORK_LINEAR_KEY' } }).declaration.variables).toEqual(
      ['WORK_LINEAR_KEY', 'LINEAR_API_KEY'],
    )
  })

  it('takes a server that is in no catalogue, when they said enough about it', () => {
    const mine = one('mine', {
      mine: { enabled: true, transport: 'stdio', command: 'mine-mcp' },
    })
    expect(mine.from).toBe('yours')
    expect(mine.problem).toBeNull()
  })
})

describe('what is wrong with a server, said in words', () => {
  it.each([
    [{ transport: 'stdio' }, 'nothing says which'],
    [{ transport: 'http' }, 'nothing says where'],
    [{ transport: 'sse' }, 'nothing says where'],
    [{ transport: 'stdio', command: 'x', auth: 'env' as const }, 'set auth_name'],
    [{ transport: 'stdio', command: 'x', auth: 'header' as const }, 'set auth_name'],
    [{ transport: 'http', url: 'u', scope: 'project' as const }, 'only a server Tade starts'],
    [{}, 'there is no server called mine in the catalogue'],
  ])('%o', (settings, said) => {
    expect(one('mine', { mine: { enabled: true, ...settings } }).problem).toContain(said)
  })

  it('says a kind of server Tade cannot talk to yet as exactly that', () => {
    // Which comes right on its own the day that transport lands, with no
    // entry anywhere changing.
    const server = declared({
      servers: { remote: { enabled: true } },
      catalogue,
      transports: ['stdio'],
    }).find((each) => each.declaration.name === 'remote')
    expect(server?.problem).toBe('Tade cannot talk to a server over http yet')
  })

  it('never hands on a server that is off, or one that cannot work', () => {
    const servers = declared({
      servers: {
        linear: { enabled: true },
        remote: {},
        mine: { enabled: true, transport: 'stdio' },
      },
      catalogue,
      transports,
    })
    expect(workable(servers).map((server) => server.declaration.name)).toEqual(['linear'])
  })
})
