import type { World } from '../scripts/still.ts'
import type { Device } from '../src/devices.ts'
import { GRANTS } from '../src/reach.ts'
import { agentHeld, input, NOW, settingRows } from './fixtures.ts'

// A world for `still.test.ts` to draw, out of this package's own fixtures:
// one device granted every reading and both acting tiers. A module of its own
// because a visit loads its world in a process of its own, by URL.

const DEVICE: Device = {
  id: 'dev_7f3a9c21',
  label: 'the stills test',
  digest: '',
  host: 'localhost:7654',
  csrf: '',
  until: NOW + 30 * 86_400_000,
  pairedAt: NOW - 86_400_000,
  scopes: ['read', 'answer', 'steer'],
  projects: null,
  granted: [...GRANTS],
  from: '127.0.0.1',
  revoked: null,
}

export const TEST_WORLD: World = {
  now: NOW,
  devices: [DEVICE],
  input: (reach) => input({ reach }),
  agent: () => agentHeld(),
  settings: () => ({ groups: settingRows(), known: [] }),
}
