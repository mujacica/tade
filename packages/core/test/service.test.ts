import { describe, expect, it } from 'vitest'
import {
  execOf,
  LOG,
  SHOWN,
  START,
  serviceStateOf,
  serviceTrouble,
  serviceUnit,
  unitTrouble,
} from '../src/service.ts'

// The user unit `tade host service` writes. It is shown before it is written,
// so what is held here is what somebody reads: what runs, with what, and what
// stopping it does. That systemd reads it the same way, hears it say it is
// ready, and that lanes outlive a restart of it, was proved in a Debian
// container under systemd 252 (`set-up-the-machine`, "Proving it").

const facts = {
  tade: ['/usr/bin/node', '/home/you/.local/lib/tade/packages/cli/src/bin.ts'],
  path: '/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin',
  home: null,
  lang: 'C.UTF-8',
}

describe('the unit', () => {
  const unit = serviceUnit(facts)
  const line = (key: string) => unit.split('\n').filter((one) => one.startsWith(`${key}=`))

  it('runs `tade serve` itself, with no terminal and no tmux in front of it', () => {
    expect(line('ExecStart')).toEqual([
      'ExecStart=/usr/bin/node /home/you/.local/lib/tade/packages/cli/src/bin.ts serve',
    ])
    expect(unit).not.toContain('tmux -L')
    expect(line('PIDFile')).toEqual([])
    expect(line('ExecStop')).toEqual([])
  })

  it('is started only once Tade says it is ready, which it says through a child of its own', () => {
    expect(line('Type')).toEqual(['Type=notify'])
    expect(line('NotifyAccess')).toEqual(['NotifyAccess=all'])
    expect(line('Restart')).toEqual(['Restart=on-failure'])
  })

  it('signals Tade alone when it stops, and leaves the agents to the scope they are in', () => {
    expect(line('KillMode')).toEqual(['KillMode=mixed'])
    expect(line('TimeoutStopSec')).toEqual(['TimeoutStopSec=30'])
    expect(unit).toContain('stopping or')
    expect(unit).toContain('never ends one')
  })

  it('says where its log is, as Tade, and how the Mac sees it', () => {
    expect(line('SyslogIdentifier')).toEqual(['SyslogIdentifier=tade'])
    expect(LOG).toBe('journalctl --user -u tade.service -f')
    expect(unit).toContain(`#   ${LOG}`)
    expect(unit).toContain('`tade remote add`')
  })

  it('carries the PATH the harnesses are on, and a locale to draw in, and no key at all', () => {
    expect(line('Environment')).toEqual([
      'Environment=PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin',
      'Environment=LANG=C.UTF-8',
    ])
    expect(unit).toContain('Keys exported in your shell do not reach a service')
  })

  it('names a home only where it is not the default', () => {
    expect(serviceUnit({ ...facts, home: '/srv/tade' })).toContain(
      'Environment=TADE_HOME=/srv/tade',
    )
  })

  it('starts with everybody’s services at boot, and is started by restarting it', () => {
    expect(line('WantedBy')).toEqual(['WantedBy=default.target'])
    expect(START).toBe(
      'systemctl --user daemon-reload && systemctl --user enable tade.service && systemctl --user reset-failed tade.service && systemctl --user restart tade.service',
    )
  })
})

describe('a path systemd would read differently', () => {
  const odd = { ...facts, tade: ['/opt/my tools/node', '/opt/my tools/100%/$tade.ts'] }

  it('is quoted, with its specifiers and variables escaped', () => {
    const unit = serviceUnit({ ...odd, path: '/opt/my tools/bin:/usr/bin' })
    expect(unit).toContain('"/opt/my tools/node" "/opt/my tools/100%%/$$tade.ts" serve')
    // An Environment value is not an Exec line: `$` stays as it is there.
    expect(unit).toContain('Environment="PATH=/opt/my tools/bin:/usr/bin"')
  })

  it('reads back as the words it was written from', () => {
    expect(execOf(serviceUnit(odd))).toEqual([...odd.tade, 'serve'])
    expect(execOf(serviceUnit(facts))).toEqual([...facts.tade, 'serve'])
    expect(execOf('[Service]\nExecStart=-/bin/a "b \\"c\\""\n')).toEqual(['/bin/a', 'b "c"'])
    expect(execOf('[Service]\nType=simple\n')).toBeNull()
  })
})

describe('a unit that is there', () => {
  const everywhere = () => true

  it('is fine where it runs `tade serve` from files that are there', () => {
    expect(unitTrouble(serviceUnit(facts), everywhere)).toBeNull()
  })

  it('is an older Tade’s where it runs the window in tmux, and says what writes this one', () => {
    const older = [
      '[Service]',
      'Type=forking',
      'ExecStart=/usr/bin/tmux -u -L tade-window new-session -d -s tade -x 200 -y 50 -P -F #{pane_pid} /usr/bin/node /x/bin.ts app',
    ].join('\n')
    const said = unitTrouble(older, everywhere)
    expect(said).toContain('older Tade’s, which runs the window in tmux')
    expect(said).toContain('`tade host service --write`')
  })

  it('names the Node or Tade it runs that is not there any more', () => {
    const gone = (path: string) => path !== '/usr/bin/node'
    expect(unitTrouble(serviceUnit(facts), gone)).toBe(
      'runs /usr/bin/node, which is not there any more: `tade host service --write` writes it for this Tade',
    )
  })

  it('says one somebody changed into something else does not run `tade serve`, and refuses nothing', () => {
    expect(unitTrouble('[Service]\nExecStart=/usr/bin/sleep 9\n', everywhere)).toContain(
      'does not run `tade serve`',
    )
    expect(unitTrouble('', everywhere)).toContain('starts nothing')
  })
})

describe('how the service stands', () => {
  const shown = (over: Record<string, string>) =>
    Object.entries({
      LoadState: 'loaded',
      ActiveState: 'inactive',
      SubState: 'dead',
      Result: 'success',
      MainPID: '0',
      NRestarts: '0',
      StatusText: '',
      ...over,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')

  it('asks for every property it reads', () => {
    for (const key of ['LoadState', 'ActiveState', 'SubState', 'Result', 'MainPID', 'StatusText'])
      expect(SHOWN).toContain(key)
  })

  it('is ready only once Tade said so: active, with its pid and its status', () => {
    const state = serviceStateOf(
      shown({
        ActiveState: 'active',
        SubState: 'running',
        MainPID: '4242',
        StatusText: 'holding ~',
      }),
    )
    expect(state).toEqual({ kind: 'ready', pid: 4242, status: 'holding ~' })
    expect(serviceTrouble(state)).toBeNull()
  })

  it('is starting while systemd waits to hear it, and stopped, failed or restarting otherwise', () => {
    expect(
      serviceStateOf(shown({ ActiveState: 'activating', SubState: 'start', MainPID: '7' })),
    ).toEqual({ kind: 'starting', pid: 7 })
    expect(serviceStateOf(shown({}))).toEqual({ kind: 'stopped' })
    expect(serviceStateOf(shown({ ActiveState: 'failed', Result: 'timeout' }))).toEqual({
      kind: 'failed',
      result: 'timeout',
    })
    expect(
      serviceStateOf(
        shown({ ActiveState: 'activating', SubState: 'auto-restart', NRestarts: '3' }),
      ),
    ).toEqual({ kind: 'restarting', restarts: 3 })
    expect(
      serviceStateOf(shown({ ActiveState: 'deactivating', SubState: 'stop-sigterm' })),
    ).toEqual({
      kind: 'stopping',
      pid: null,
    })
    expect(serviceStateOf(shown({ LoadState: 'not-found' }))).toEqual({ kind: 'unread' })
    expect(serviceStateOf('')).toMatchObject({ kind: 'cannot' })
  })

  it('says what to do about each, never nothing', () => {
    expect(serviceTrouble({ kind: 'stopped' })).toBe(`it is not running: \`${START}\``)
    expect(serviceTrouble({ kind: 'unread' })).toContain('daemon-reload')
    expect(serviceTrouble({ kind: 'failed', result: 'timeout' })).toContain(
      'never said it was ready',
    )
    expect(serviceTrouble({ kind: 'failed', result: 'exit-code' })).toContain(
      'it failed (exit-code): `journalctl --user -u tade.service` says why',
    )
    // The start limit counts a person's restarts too, and `START` clears it.
    expect(serviceTrouble({ kind: 'failed', result: 'start-limit-hit' })).toContain(
      `five times in five minutes, so systemd stopped trying — \`journalctl --user -u tade.service\` says why, and \`${START}\``,
    )
    expect(START).toContain('reset-failed tade.service && systemctl --user restart')
    expect(serviceTrouble({ kind: 'restarting', restarts: 2 })).toContain('2 so far')
    expect(serviceTrouble({ kind: 'starting', pid: 1 })).toContain('not yet said it is ready')
    expect(serviceTrouble({ kind: 'cannot', why: 'there is no systemctl here' })).toBe(
      'whether it is running cannot be told: there is no systemctl here',
    )
  })
})
