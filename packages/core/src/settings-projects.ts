import { AGENT_WORKSPACES, type Config } from './config.ts'
import type { SettingGroup } from './settings.ts'

// What one project answers for itself, as a person changes it.
//
// Its own half of `settingsOf`, split off when that file reached the size a
// file is allowed to be. It is a seam rather than a cut: these are exactly the
// settings `ALLOWED_UNDER` is about (`reach.ts`), exactly the ones Configure
// on a project's tab scopes to, and exactly the ones whose titles have to name
// the *setting* rather than the project, because a project's own name never
// names anything inside it (`wordsFor`).
//
// Pure, like the table it came out of: a config in, described groups out.

/** The three groups that are one project's own answers: what it is, what it checks, what it may spend. */
export function projectGroups(config: Config): SettingGroup[] {
  const projects = Object.entries(config.projects)
  return [
    {
      id: 'projects',
      title: 'Projects',
      about: 'The repositories Tade can start work in.',
      settings: projects.flatMap(([name, project]) => [
        {
          path: `projects.${name}.root`,
          title: name,
          means: 'where the repository is',
          value: project.root,
          fallback: '',
          type: { kind: 'text', placeholder: '~/src/app' } as const,
          live: false,
        },
        {
          // A label and never the id (`ProjectConfigSchema.title`), said in
          // `means` too: this is where somebody types one and wonders what it
          // will move.
          path: `projects.${name}.title`,
          title: `${name} name`,
          means: `what to call ${name} on screen; its task ids, its commits and its journal keep the name ${name}`,
          value: project.title ?? '',
          fallback: name,
          type: { kind: 'text', placeholder: name } as const,
          live: true,
          keywords: ['rename', 'name', 'title', 'label'],
        },
        {
          path: `projects.${name}.brief`,
          title: `${name} brief`,
          means: 'one line the orchestrator is told about this project',
          value: project.brief ?? '',
          fallback: 'none',
          type: { kind: 'text', placeholder: 'Payments. Stripe, Postgres, Node.' } as const,
          live: false,
        },
        {
          // Empty follows the Agents setting: two projects on one machine want
          // different answers — agents side by side where work is sequential,
          // a worktree each where two efforts are unrelated — and tasks that
          // already exist keep the answer they were made with.
          path: `projects.${name}.workspace`,
          title: `${name} — where agents work`,
          means: `checkout: all of ${name}'s agents in its own checkout at once; worktree: one each`,
          value: project.workspace ?? '',
          fallback: config.agents.workspace,
          type: { kind: 'choice', options: ['', ...AGENT_WORKSPACES] } as const,
          live: true,
          keywords: [name, 'workspace', 'worktree', 'checkout'],
        },
      ]),
    },
    {
      // The schema has always allowed `projects.<name>.checks`, and `checksFor`
      // has always read it; until this group there was no way to set one, which
      // made it a key that read like a promise Tade did not keep.
      id: 'project-checks',
      title: 'Checks per project',
      about:
        "One project's own answer to the Checks rules. Left empty it follows the rule above; what a project actually checks is read from its own workflows and commit hook, which Settings does not hold because they live in the repository.",
      settings: projects.flatMap(([name, project]) => [
        {
          path: `projects.${name}.checks.before`,
          title: `${name} — needed before`,
          means: `when Tade runs ${name}'s checks unasked, whatever the rule above says; holding a push still needs approvals.mode policy`,
          value: project.checks?.before ?? '',
          fallback: config.checks.before,
          type: { kind: 'choice', options: ['', 'off', 'commit', 'push', 'commit and push'] },
          live: true,
          keywords: [name, 'checks', 'gate', 'push'],
        },
        {
          path: `projects.${name}.checks.on_red`,
          title: `${name} — when one is red`,
          means: `what a failed required check does in ${name}`,
          value: project.checks?.on_red ?? '',
          fallback: config.checks.on_red,
          type: { kind: 'choice', options: ['', 'hold', 'tell', 'note'] },
          live: true,
          keywords: [name, 'checks', 'red', 'fail'],
        },
        {
          path: `projects.${name}.checks.parallel`,
          title: `${name} — at once`,
          means: `how many of ${name}'s checks may run at once here`,
          value: project.checks?.parallel === undefined ? '' : String(project.checks.parallel),
          fallback: String(config.checks.parallel),
          type: { kind: 'number' } as const,
          live: true,
          keywords: [name, 'checks', 'parallel'],
        },
        // One row per check somebody has answered about on the ACTIONS page —
        // and only those, because a check id is only knowable by reading the
        // repository and this function reads nothing. So this is where an
        // override is seen, searched for and undone; making a new one is the
        // page's, where the checks actually are.
        ...Object.entries(project.checks?.run_here ?? {}).map(([id, runs]) => ({
          path: `projects.${name}.checks.run_here.${id}`,
          title: `${name} — run ${id} here`,
          means: `whether Tade runs ${name}'s ${id} check on this machine, over what its own CI and commit hook say`,
          value: String(runs),
          fallback: 'what the project says',
          type: { kind: 'flag' } as const,
          live: true,
          keywords: [name, 'checks', id, 'here', 'run'],
        })),
      ]),
    },
    {
      id: 'budgets',
      title: 'Budgets',
      about: 'How much each project may spend a day before new agents are refused.',
      settings: projects.map(([name, project]) => ({
        // `app budget` rather than `app`, redundant under a heading that says
        // Budgets and right anyway: a title is what a refusal tells somebody to
        // say back, and a project's own name no longer names anything inside
        // that project (`wordsFor`), so "say app" was advice that did nothing.
        path: `projects.${name}.budget.usd_per_day`,
        title: `${name} budget`,
        means: 'dollars a day; agents are warned at 80% and refused past it',
        value: project.budget?.usd_per_day === undefined ? '' : String(project.budget.usd_per_day),
        fallback: 'no budget',
        type: { kind: 'number' } as const,
        live: false,
      })),
    },
  ]
}
