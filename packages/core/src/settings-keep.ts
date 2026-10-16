import type { Config } from './config.ts'
import type { SettingGroup } from './settings.ts'

// What Tade keeps and when it lets go of it: the journal's ceiling and how
// long a document somebody decided about is kept. One group because it is one
// question somebody comes with — "what is taking the space, and what goes" —
// and its own file because `settings.ts` is at its budget, the same reason
// `settings-away.ts` and `settings-intake.ts` give.

export function keepGroup(config: Config): SettingGroup {
  return {
    id: 'journal',
    title: 'Journal',
    about:
      'What Tade keeps, and when it lets go. The documents tasks produced outlive their tasks, in each project’s documents folder in Tade’s home, until somebody deletes one or the cleanup takes one that was decided about. events.jsonl is the truth and everything folds over all of it, so its size is what every statistic costs to read. Its index beside it (events.jsonl.db) is derived from it and rebuilt whenever the two disagree — deleting that file is always safe, and costs one rebuild on the next open.',
    keywords: [
      'journal',
      'events',
      'events.jsonl',
      'index',
      'database',
      'db',
      'disk',
      'size',
      'space',
      'history',
      'log',
      'compaction',
      'retention',
      'prune',
      'delete',
    ],
    settings: [
      {
        path: 'journal.max_mb',
        title: 'Journal size',
        means:
          'megabytes; past it the oldest sampled byte counts are dropped on the next open — 86% of the lines, which nothing reads back — and nothing else ever is',
        value: String(config.journal.max_mb),
        fallback: '16 MB',
        type: { kind: 'number', unit: 'MB' } as const,
        live: false,
        keywords: ['compact', 'ceiling', 'grow', 'trace', 'output'],
      },
      {
        path: 'documents.keep_days',
        title: 'Keep decided documents',
        means:
          'days; a document a task produced that somebody decided about this long ago, whose follow-up has all finished, is deleted on the next open and the journal says so — one nobody decided about is never deleted unasked',
        value: String(config.documents.keep_days),
        fallback: '30 days',
        type: { kind: 'number', unit: 'days' } as const,
        live: false,
        keywords: ['documents', 'research', 'analysis', 'cleanup', 'clean up', 'keep'],
      },
      {
        path: 'notes.keep_days',
        title: 'Keep notes about gone work',
        means:
          'days; a note about a task that finished or was removed this long ago is retired on the next open and the journal says so — no longer told to agents or the orchestrator, still read on asking; a note about a project or about everything is never retired unasked',
        value: String(config.notes.keep_days),
        fallback: '3 days',
        type: { kind: 'number', unit: 'days' } as const,
        live: false,
        keywords: ['notes', 'remember', 'retire', 'duplicate', 'cleanup', 'clean up', 'keep'],
      },
      {
        path: 'drivers.pty.scrollback',
        title: 'Lane scrollback',
        means:
          'lines each lane keeps to scroll back through, when lanes run under pty; every line is memory in every lane for as long as it lives, and fewer is history you cannot get back',
        value: String(config.drivers.pty.scrollback),
        fallback: '10,000 lines',
        type: { kind: 'number', unit: 'lines' } as const,
        live: false,
        keywords: ['scrollback', 'scroll back', 'terminal', 'lines', 'memory', 'ram', 'pty'],
      },
    ],
  }
}
