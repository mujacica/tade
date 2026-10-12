import { dryRunSays, planReport, readTemplates } from '@tade/core'
import { dryRunTemplate, usedSays, useTemplate, type Workbench } from '@tade/workbench'

// The `ToolHost` methods behind the template tools (`tools-templates.ts`):
// list, dry-run and use. Their own file because `tool-host.ts` was at its
// budget, and because three methods that share one boundary read better in
// one place.
//
// Three methods and deliberately not a fourth: there is no way from here to
// write a template, publish one, or reach a draft nobody at this machine has
// read. What the orchestrator may stamp out is what somebody here already
// published, and using one makes tasks that are parked — so even this goes
// nowhere until a person picks one up.

type Handler = (params: Record<string, unknown>) => Promise<string>

export function templateMethods(tade: Workbench): Record<string, Handler> {
  return {
    'template/list': async () => templatesSaid(await readTemplates(tade.home)),
    'template/dry-run': async (p) => dryRunSays(await dryRun(tade, p)).join('\n'),
    'template/use': async (p) =>
      usedSays(
        await useTemplate(tade, {
          template: String(p.template ?? ''),
          ...(p.version === undefined ? {} : { version: Number(p.version) }),
          inputs: inputsOf(p.inputs),
          by: 'orchestrator',
        }),
      ),
  }
}

/**
 * What a template is filled in with, as the orchestrator sent it.
 *
 * Every value becomes a string here and nowhere else decides: an input is a
 * project name, a short name, a line of words or a body of material, and
 * `fillTemplate` refuses each by its declared kind. Nothing here is joined
 * into a prompt or a command — a filled value only ever reaches a task's
 * context file — so the worst a malformed one can do is be refused.
 */
function inputsOf(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('inputs is what the template is filled in with: an object of name to value')
  }
  const out: Record<string, string> = {}
  for (const [name, said] of Object.entries(value)) {
    // Text, a number or a flag, and never a structure: `[object Object]` in a
    // task's context file is a value somebody meant to pass and nobody can
    // read, and the one thing worse than refusing it is keeping it.
    if (said !== null && (typeof said === 'object' || typeof said === 'function')) {
      throw new Error(`inputs.${name} has to be text: a template is filled in with words`)
    }
    out[name] = typeof said === 'string' ? said : String(said ?? '')
  }
  return out
}

/**
 * What one template would make, asked of the workbench.
 *
 * `drafts` is never passed, which is the bound: the orchestrator reads what a
 * person at this machine has published, and a draft nobody has read is not
 * that. Plan windows come from the workbench's own harnesses, so this answer
 * says where each sign-in stands rather than "cannot tell".
 */
async function dryRun(tade: Workbench, p: Record<string, unknown>) {
  const dry = await dryRunTemplate(
    {
      home: tade.home,
      config: tade.config,
      events: (filter) => tade.log.read(filter),
    },
    {
      template: String(p.template ?? ''),
      ...(p.version === undefined ? {} : { version: Number(p.version) }),
      inputs: inputsOf(p.inputs),
    },
    planReport(tade.planUsage(), Date.now()).signIns.map((one) =>
      one.cannotTell
        ? `${one.label}: cannot tell — ${one.cannotTell}`
        : `${one.label}: ${one.windows.map((w) => `${w.label} ${w.used}% used`).join(', ') || 'nothing to say'}`,
    ),
  )
  if ('problem' in dry) throw new Error(dry.problem)
  return dry
}

/** The templates there are, as something to choose from: only published ones. */
function templatesSaid(read: Awaited<ReturnType<typeof readTemplates>>): string {
  const lines: string[] = []
  for (const one of read.templates) {
    if (one.versions.length === 0) continue
    const newest = one.versions[0]
    const title = one.draft?.ok ? one.draft.template.title : ''
    lines.push(
      `${one.name}@${newest}${one.builtIn ? ' (built in)' : ''}${title ? ` — ${title}` : ''}${
        one.versions.length > 1
          ? ` · also ${one.versions
              .slice(1)
              .map((v) => `@${v}`)
              .join(', ')}`
          : ''
      }`,
    )
  }
  // No "nothing published" case: the ones Tade ships are published by
  // construction, so this list is never empty and a branch for it would be
  // dead code with a kind sentence in it. What does need saying every time is
  // the bound, because it is the thing a model would otherwise try.
  return [
    'Published templates. Dry-run one to see what it would make and what it takes.',
    'You cannot write, change or publish one: that is a person at this machine.',
    ...lines.map((line) => `  ${line}`),
  ].join('\n')
}
