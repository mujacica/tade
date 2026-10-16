import { describe, expect, it } from 'vitest'
import { ATTACH, serviceUnit } from '../src/service.ts'

// The user unit `tade host service` writes. It is shown before it is written,
// so what is held here is what somebody reads: what runs, with what, and what
// stopping it does. That systemd reads it the same way, and that lanes outlive
// a restart of it, was proved in a Debian container under systemd 252.

const facts = {
  tade: ['/home/you/.local/bin/tade'],
  tmux: '/usr/bin/tmux',
  path: '/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin',
  home: null,
  lang: 'C.UTF-8',
}

describe('the unit', () => {
  const unit = serviceUnit(facts)
  const line = (key: string) => unit.split('\n').filter((one) => one.startsWith(`${key}=`))

  it('runs the window in tmux on a server of its own, which anybody can attach to', () => {
    expect(line('ExecStart')).toEqual([
      'ExecStart=/usr/bin/tmux -u -L tade-window new-session -d -s tade -x 200 -y 50 -P -F #{pane_pid} /home/you/.local/bin/tade app',
    ])
    expect(unit).toContain(ATTACH)
    expect(ATTACH).toBe('tmux -L tade-window attach -t tade')
  })

  it('makes Tade its main process, so a failure restarts it and quitting does not', () => {
    expect(line('Type')).toEqual(['Type=forking'])
    // tmux prints the pane's pid — Tade's — into the file systemd reads it from.
    expect(line('PIDFile')).toEqual(['PIDFile=%t/tade-window.pid'])
    expect(line('StandardOutput')).toEqual(['StandardOutput=truncate:%t/tade-window.pid'])
    // Or tmux's own complaints would be written into the pid file too.
    expect(line('StandardError')).toEqual(['StandardError=journal'])
    expect(line('Restart')).toEqual(['Restart=on-failure'])
  })

  it('signals Tade first when it stops, and leaves the agents to the scope they are in', () => {
    expect(line('KillMode')).toEqual(['KillMode=mixed'])
    expect(unit).toContain('stopping or')
    expect(unit).toContain('never ends one')
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

  it('starts with everybody’s services at boot', () => {
    expect(line('WantedBy')).toEqual(['WantedBy=default.target'])
  })
})

describe('a path systemd would read differently', () => {
  it('is quoted, with its specifiers and variables escaped', () => {
    const unit = serviceUnit({
      ...facts,
      tade: ['/opt/my tools/node', '/opt/my tools/100%/$tade.ts'],
      path: '/opt/my tools/bin:/usr/bin',
    })
    expect(unit).toContain('"/opt/my tools/node" "/opt/my tools/100%%/$$tade.ts" app')
    // An Environment value is not an Exec line: `$` stays as it is there.
    expect(unit).toContain('Environment="PATH=/opt/my tools/bin:/usr/bin"')
  })
})
