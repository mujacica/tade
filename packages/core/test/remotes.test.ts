import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config-file.ts'
import { REMOTE_KEPT_HERE, remotePort } from '../src/remotes.ts'

// `remotes.<name>`: another machine's Tade this one is an owner of. Every value
// that reaches another program is refused at the schema for anything that is
// not its shape, because a destination becomes an argument to ssh and a
// command a word a remote shell reads.

const SESSION = 'ab12cd34ef56.Qp3vNn1bXg7kQ2mPvR4tLz8wXg7kQ2mPvR4tLz8w'
const ONE = `remotes:
  vps:
    ssh: me@vps.example.com
    device: ab12cd34ef56
    session: ${SESSION}
    csrf: Xg7kQ2mPvR4tLz8wXg7kQ2mPvR4t
    host: localhost:7654
`

describe('remotes in the config', () => {
  it('has none until somebody adds one', () => {
    const read = parseConfig('')
    expect(read.ok && read.config.remotes).toEqual({})
  })

  it('takes a remote as `tade remote add` writes one, with tade as the command unless it says', () => {
    const read = parseConfig(ONE)
    expect(read.ok, read.ok ? '' : JSON.stringify(read.issues)).toBe(true)
    if (!read.ok) return
    expect(read.config.remotes.vps).toMatchObject({
      ssh: 'me@vps.example.com',
      tade: 'tade',
      host: 'localhost:7654',
    })
    expect(remotePort(read.config.remotes.vps as { host: string })).toBe(7654)
    const elsewhere = parseConfig(
      ONE.replace('    host:', '    tade: ~/.npm-global/bin/tade\n    host:'),
    )
    expect(elsewhere.ok && elsewhere.config.remotes.vps?.tade).toBe('~/.npm-global/bin/tade')
    expect(parseConfig(ONE.replace('me@vps.example.com', 'ssh://me@10.0.0.2:2222')).ok).toBe(true)
  })

  it.each([
    [
      'an option where the destination goes',
      'ssh: me@vps.example.com',
      'ssh: -oProxyCommand=sh',
      'remotes.vps.ssh',
    ],
    [
      'two commands where one goes',
      'host: localhost:7654',
      'host: localhost:7654\n    tade: tade;reboot',
      'remotes.vps.tade',
    ],
    [
      'a session bound to a public name',
      'host: localhost:7654',
      'host: tade.example.com',
      'remotes.vps.host',
    ],
    ['a session that is not one', `session: ${SESSION}`, 'session: hello', 'remotes.vps.session'],
    ['a name with capitals in it', '  vps:', '  VPS:', 'remotes.VPS'],
  ])('refuses %s, by its dotted key', (_what, from, to, path) => {
    const read = parseConfig(ONE.replace(from, to))
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.issues[0]?.path).toEqual(path)
  })

  it('reads past a key nobody declared, and names it by its dotted key', () => {
    // Read past rather than refused: `tade remote add` on a newer Tade may
    // write a key this one has no setting for, and refusing the file would
    // take every setting away from a window here. The remote is reached as
    // the keys this Tade knows say.
    const read = parseConfig(
      ONE.replace('host: localhost:7654', 'host: localhost:7654\n    port: 22'),
    )
    expect(read.ok && read.unknown).toEqual(['remotes.vps.port'])
    expect(read.ok && read.config.remotes.vps?.host).toBe('localhost:7654')
  })

  it('says where the session is kept and who can read it, with the way out', () => {
    expect(REMOTE_KEPT_HERE).toContain('config.yaml')
    expect(REMOTE_KEPT_HERE).toContain('any agent you run can read it')
    expect(REMOTE_KEPT_HERE).toContain('tade remote remove')
  })
})
