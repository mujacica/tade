import type { Reach, SnapshotInput } from '@tade/web'
import type { World } from '../../../../web/scripts/still.ts'
import { PAGE_WORLD } from './away-page.ts'
import { NOW } from './fixtures.ts'

// The away view's Machines, for the README: the same morning as the page's own
// pictures (`away-page.ts`), on two machines that are plainly not alike — the
// laptop the page talks to, busy with the morning's agents, and the server it
// links to, quiet with room to spare. The contrast is the point: one look says
// which machine to put the next agent on.
//
// Only the figures differ from `PAGE_WORLD`; every project, task and device is
// the same, so the overview this is taken from is the one the reel shows. Made
// up, every one — no host name, no figure off a real machine.

const ago = (minutes: number) => NOW - minutes * 60_000
const GB = 1024 ** 3

/** A trail of looks for a sparkline, five seconds apart: a level, a swing, and how jumpy. */
const trail = (base: number, swing: number, jumpy: number) =>
  Array.from(
    { length: 36 },
    (_, at) => Math.round((base + swing * Math.sin(at / 3) + (at % 4) * jumpy) * 10) / 10,
  )

/** The laptop: four agents at work, the fans on — amber memory, red processors. */
const LAPTOP = {
  at: new Date(NOW).toISOString(),
  cores: 8,
  cpu: 92,
  load: 9.41,
  memory: { used: 13.4 * GB, total: 16 * GB },
  tade: { cpu: 486, memory: 6.8 * GB, processes: 23 },
  disk: { free: 148 * GB, total: 460 * GB, volumes: 1 },
  trail: { cpu: trail(84, 8, 1.1), memory: trail(80, 2, 1.1) },
}

/** The server: one agent, nothing waiting on it, most of everything free. */
const SERVER = {
  at: new Date(ago(0.1)).toISOString(),
  cores: 16,
  cpu: 4,
  load: 0.38,
  memory: { used: 7.2 * GB, total: 64 * GB },
  tade: { cpu: 2.1, memory: 412 * 1024 ** 2, processes: 3 },
  disk: { free: 1.6 * 1024 * GB, total: 1.9 * 1024 * GB, volumes: 1 },
  trail: { cpu: trail(4, 0.6, 0), memory: trail(11, 0.2, 0) },
}

export const MACHINES_WORLD: World = {
  ...PAGE_WORLD,
  input: (reach: Reach): SnapshotInput => ({
    ...PAGE_WORLD.input(reach),
    host: LAPTOP,
    machines: [{ name: 'server', way: 'to', state: 'up', since: ago(330), host: SERVER }],
  }),
}
