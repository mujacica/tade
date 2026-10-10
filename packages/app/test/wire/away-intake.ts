import type { Config } from '@tade/core'
import type { Machine } from './away-harness.ts'

// The intake half of the away harness: the grant, the home's own config, and
// one request handed over through the door a watch actually uses.
//
// **Its own file because it is a different subject and the harness was at the
// length a file is allowed to be.** Everything here is about work arriving
// from outside: what the two configs have to agree about, and the one call
// that puts a request through the real pipeline.

/** The window's own intake block, where a test asks for one. */
export const INTAKE = {
  enabled: true,
  sources: { cli: { accept: true, projects: ['app'], from: ['kim'] } },
}

/** The home's own `config.yaml`, which is what the workbench reads. */
export function homeConfig(root: string, intake: boolean): string {
  const lines = ['projects:', '  app:', `    root: ${root}`]
  if (intake) {
    lines.push(
      'surfaces:',
      '  intake:',
      '    enabled: true',
      '    sources:',
      '      cli:',
      '        accept: true',
      '        projects: [app]',
      '        from: [kim]',
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * One request handed to this machine through the door a watch actually uses.
 *
 * `watchFound` and not `takeIntake`: which keys get written down as *found* is
 * half the dedupe, and a fixture that called the rule underneath would make a
 * proposal nothing could later recognise as the same request.
 */
export async function delivered(
  one: Machine,
  over: { revision?: string; requester?: string } = {},
): Promise<string> {
  await one.client.setSchedule(
    {
      id: 'intake-cli',
      name: 'intake cli',
      project: 'app',
      said: '',
      when: { every: '5m' },
      does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
      missed: 'skip',
      by: 'you',
      created: '2026-10-01T08:00:00.000Z',
    },
    'you',
  )
  const revision = over.revision ?? '1'
  const taken = await one.client.watchFound(
    'intake-cli',
    {
      key: `cli:req-1:${revision}`,
      title: 'cli req-1',
      intake: {
        source: 'cli',
        externalId: 'req-1',
        revision,
        url: 'https://example.invalid/req-1',
        requester: { id: over.requester ?? 'kim', label: 'Kim', bot: false },
        from: 'app',
        verbatim: 'the export button 500s when the selection is empty',
        material: { ref: 'req-1.0001.json', hash: 'sha256:aaa' },
        attachments: [],
        sourceAt: '2026-10-09T00:00:00.000Z',
        seenAt: '2026-10-09T00:01:00.000Z',
        correlation: `req-1-${revision}`,
      },
    },
    { agent: { title: 'cli req-1', prompt: 'A request came in from cli (req-1).' } },
  )
  const task = taken.task ?? ''
  if (task === '') throw new Error(`that delivery made nothing: ${taken.outcome}`)
  one.watch(task)
  await one.refresh()
  return task
}
