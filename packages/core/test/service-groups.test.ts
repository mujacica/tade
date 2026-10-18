import { describe, expect, it } from 'vitest'
import { START } from '../src/service.ts'
import { processGroupsOf, serviceGroupTrouble } from '../src/service-groups.ts'

describe('the groups the running service holds', () => {
  // `/proc/<pid>/status` of a `tade serve` begun before `usermod` put its user
  // in tade-agent's group (1001): its own groups, and its manager's pid.
  const status = [
    'Name:\tnode',
    'Umask:\t0007',
    'State:\tS (sleeping)',
    'Pid:\t4242',
    'PPid:\t917',
    'Uid:\t1000\t1000\t1000\t1000',
    'Gid:\t1000\t1000\t1000\t1000',
    'Groups:\t4 27 1000 ',
  ].join('\n')

  it('are read off the process — its own and its supplementary ones — with who started it', () => {
    expect(processGroupsOf(status)).toEqual({ parent: 917, uid: 1000, groups: [1000, 4, 27] })
    expect(processGroupsOf('Groups:\t\nGid:\t5\t6\t6\t6')).toMatchObject({ groups: [6] })
    expect(processGroupsOf('')).toBeNull()
  })

  it('say nothing where it holds the group', () => {
    const held = { user: 'tade-agent', pid: 4242, held: true, manager: true, uid: 1000 }
    expect(serviceGroupTrouble(held, 'tade')).toBeNull()
  })

  it('say to restart the service, with the command, where its manager has the group', () => {
    const one = { user: 'tade-agent', pid: 4242, held: false, manager: true, uid: 1000 }
    expect(serviceGroupTrouble(one, 'tade')).toBe(
      `Tade's service (pid 4242) started before tade was put in tade-agent's group and does not have it, so no agent can start as tade-agent: restart it — \`${START}\``,
    )
  })

  it('say to restart the manager it has its groups from where that lacks it too, and what that stops', () => {
    const one = { user: 'tade-agent', pid: 4242, held: false, manager: false, uid: 1000 }
    const said = serviceGroupTrouble(one, 'tade')
    expect(said).toContain('restarting it alone changes nothing')
    expect(said).toContain('`sudo systemctl restart user@1000.service`')
    expect(said).toContain("the agents' tmux among them")
    // A manager that could not be read is no reason to offer what may not work.
    expect(serviceGroupTrouble({ ...one, manager: null }, 'tade')).toContain('user@1000.service')
  })
})
