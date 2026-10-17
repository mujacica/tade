import { describe, expect, it } from 'vitest'
import {
  BACKUP_SERVICE,
  BACKUP_START,
  BACKUP_TIMER,
  backupUnits,
  execOf,
  serviceUnit,
} from '../src/service.ts'

// The two units `tade host backup --timer` writes: a oneshot that runs the
// backup with what the service runs Tade with, and the timer that starts it
// hourly. Shown before they are written, so what is held here is what
// somebody reads.

const facts = {
  tade: ['/usr/bin/node', '/home/you/.local/lib/tade/packages/cli/src/bin.ts'],
  path: '/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin',
  home: '/home/you/tade home',
  lang: 'C.UTF-8',
}

describe('the backup units', () => {
  const { service, timer } = backupUnits(facts)
  const line = (text: string, key: string) =>
    text.split('\n').filter((one) => one.startsWith(`${key}=`))

  it('runs `tade host backup` once, with the Node, CLI, PATH and home the service runs', () => {
    expect(line(service, 'Type')).toEqual(['Type=oneshot'])
    expect(execOf(service)).toEqual([...facts.tade, 'host', 'backup'])
    // The same words the service's own unit is written with, so both start one Tade.
    expect(line(service, 'Environment')).toEqual(line(serviceUnit(facts), 'Environment'))
    expect(line(service, 'Environment')).toContain('Environment="TADE_HOME=/home/you/tade home"')
  })

  it('stays out of the agents’ way while it reads', () => {
    expect(line(service, 'Nice')).toEqual(['Nice=10'])
    expect(line(service, 'IOSchedulingClass')).toEqual(['IOSchedulingClass=idle'])
    expect(line(service, 'SyslogIdentifier')).toEqual(['SyslogIdentifier=tade-backup'])
  })

  it('is started hourly, spread, and catches up one run missed while the box was off', () => {
    expect(line(timer, 'OnCalendar')).toEqual(['OnCalendar=hourly'])
    expect(line(timer, 'RandomizedDelaySec')).toEqual(['RandomizedDelaySec=10min'])
    expect(line(timer, 'Persistent')).toEqual(['Persistent=true'])
    expect(line(timer, 'WantedBy')).toEqual(['WantedBy=timers.target'])
  })

  it('names itself and the line that starts it', () => {
    expect(BACKUP_SERVICE).toBe('tade-backup.service')
    expect(BACKUP_TIMER).toBe('tade-backup.timer')
    expect(BACKUP_START).toBe(
      'systemctl --user daemon-reload && systemctl --user enable --now tade-backup.timer',
    )
    expect(service).toContain(`journalctl --user -u ${BACKUP_SERVICE}`)
  })
})
