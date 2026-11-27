// How hard an agent thinks — its own file, apart from `config.ts`, because the
// agent menu offers these wherever the window is drawn, a browser included
// (`pure.ts`), and the config's schema reaches the disk. `config.ts` hands
// them on, so nothing that imports them from there changes.

/**
 * How hard an agent thinks before it answers, least to most. A harness takes
 * the nearest its model can do: a model that cannot think at all is `off`
 * whatever it is asked.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
