import { type Config, QUEUE_HOLDS } from './config.ts'
import type { SettingGroup } from './settings.ts'

// Queued work, and who decides about it once it is held. Its own file because
// `settings.ts` is at its budget, the reason `settings-keep.ts` gives.

export function queueGroup(config: Config): SettingGroup {
  return {
    id: 'queue',
    title: 'Queue',
    about:
      'Work waiting to start. Tade starts it by rule when what it waits on finishes, and holds it when something it was planned to change is being changed by somebody else — a hold the tree caused heals by itself once that is committed.',
    keywords: ['queued', 'smart queue', 'plan', 'waits'],
    settings: [
      {
        // Read by `heldMessage` at every hold, so it is live: the
        // orchestrator's prompt says it as it stood at start, and each hold
        // says it again as it stands then.
        path: 'queue.holds',
        title: 'Who decides what is held',
        means:
          'orchestrator: it decides — a wait, a retelling, starting it anyway or leaving it to heal — and tells you what it did; ask: it tells you and does what you choose. It may do the same things either way',
        value: config.queue.holds,
        fallback: 'orchestrator',
        type: { kind: 'choice', options: [...QUEUE_HOLDS] },
        keywords: ['held', 'hold', 'on hold', 'overlaps', 'collisions'],
        live: true,
      },
    ],
  }
}
