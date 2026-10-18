import type { Config, ThinkingLevel } from './config.ts'
import { HARNESS_CHOICES } from './model.ts'
import { orchestratorAccount, ownSignInName } from './project.ts'
import type { Setting, SettingGroup } from './settings.ts'
import { accountsAbout, ownSignInSaid } from './settings-models.ts'

// The one you talk to: what it runs in, on and at, and when Tade makes its
// conversation shorter. Its own file because `settings.ts` is at its budget,
// the reason `settings-keep.ts` gives.

/** `levels` is what its harness can be told to think at, least to most. */
export function orchestratorGroup(config: Config, levels: readonly ThinkingLevel[]): SettingGroup {
  return {
    id: 'orchestrator',
    title: 'Orchestrator',
    about: 'The one you talk to.',
    settings: [
      {
        path: 'orchestrator.harness',
        title: 'Harness',
        means: 'the program you talk through; each harness keeps its own conversation',
        value: config.orchestrator.harness,
        fallback: 'pi',
        // Only the harnesses that can be the thing you talk to.
        type: {
          kind: 'choice',
          options: HARNESS_CHOICES.filter((one) => one.orchestrates).map((one) => one.id),
        },
        keywords: ['claude', 'code', 'pi', 'agent'],
        live: false,
      },
      {
        path: 'orchestrator.model',
        title: 'Model',
        means: 'what you talk to. Omit to use whatever the harness is logged in to',
        value: config.orchestrator.model
          ? config.orchestrator.provider
            ? `${config.orchestrator.provider}/${config.orchestrator.model}`
            : config.orchestrator.model
          : '',
        fallback: 'the harness decides',
        type: { kind: 'model', harness: config.orchestrator.harness },
        live: false,
      },
      {
        path: 'orchestrator.thinking',
        title: 'Thinking',
        means: 'how hard it thinks before it answers; it moves from its next reply',
        value: config.orchestrator.thinking ?? '',
        fallback: 'the harness decides',
        type: { kind: 'choice', options: [...levels] },
        live: true,
      },
      ...accountRow(config),
      {
        path: 'orchestrator.reflect',
        title: 'Look back at finished tasks',
        means: 'write down a lesson when a task lands, if there is one to write',
        value: String(config.orchestrator.reflect),
        fallback: 'true',
        type: { kind: 'flag' },
        live: true,
      },
      {
        // Read by the window between turns, so it moves at once.
        path: 'orchestrator.compact_at',
        title: 'Compact at',
        means:
          'how full its context may get before Tade compacts it — between turns, never while you type — keeping the conversation and its session, shorter. 0 leaves it to the harness',
        value: String(config.orchestrator.compact_at),
        fallback: '80',
        type: { kind: 'number', unit: '% of its context' },
        keywords: ['context', 'compaction', 'compact', 'summarise', 'full', 'tokens', 'limit'],
        live: true,
      },
    ],
  }
}

/**
 * Which of its harness's sign-ins it runs as, where somebody has added one
 * beside the harness's own: the way off a plan that has run out, since an
 * orchestrator out of turns cannot be asked to move itself. Choosing one
 * starts it again there at once, its conversation carried with it.
 */
function accountRow(config: Config): Setting[] {
  const harness = HARNESS_CHOICES.find((one) => one.id === config.orchestrator.harness)
  const names = Object.keys(config.accounts).filter(
    (name) => config.accounts[name]?.harness === config.orchestrator.harness,
  )
  if (!harness || names.length === 0) return []
  const own = ownSignInSaid(harness.title, ownSignInName(config, harness.id))
  return [
    {
      path: 'orchestrator.account',
      title: 'Account',
      means: `which of your ${harness.title} sign-ins you talk through; it starts again on it at once, its conversation with it`,
      value: orchestratorAccount(config) ?? '',
      fallback: own,
      type: {
        kind: 'choice',
        options: ['', ...names],
        list: true,
        about: accountsAbout(harness.title, names, { '': own }),
      },
      live: true,
      keywords: [`${harness.title} sign-in`, `${harness.title} subscription`, 'plan', 'quota'],
    },
  ]
}
