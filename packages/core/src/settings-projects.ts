import { AGENT_WORKSPACES, type Config } from './config.ts'
import { PUSH_MODES, pushDefault, pushFor, workspaceFor } from './project.ts'
import type { Setting, SettingGroup } from './settings.ts'

// What one project answers for itself, as a person changes it.
//
// Its own half of `settingsOf`, split off when that file reached the size a
// file is allowed to be. It is a seam rather than a cut: these are exactly the
// settings `ALLOWED_UNDER` is about (`reach.ts`), exactly the ones Configure
// on a project's tab scopes to, and exactly the ones whose titles name the
// *setting* rather than the project, because a project's own name never names
// anything inside it (`wordsFor`).
//
// **One group, not three.** It was Projects, Checks per project and Budgets —
// three menu items, each a list of every project, so configuring one project
// meant visiting three of them and reading past the other projects in each.
// They are one question with a scope on it: which project, then everything
// that project answers. So every row carries `scope`, the page shows one scope
// at a time behind a selector, and a list that crosses them says which per row
// (`settingLabel`).
//
// Pure, like the table it came out of: a config in, described groups out.

/** Everything one project answers for itself: what it is, what it checks, what it may spend. */
export function projectGroups(config: Config): SettingGroup[] {
  const projects = Object.entries(config.projects)
  return [
    {
      id: 'projects',
      title: 'Projects',
      about:
        "Each repository Tade can start work in: where it is, what it is called, what its agents do with finished work, its own answers to the check rules, and what it may spend. Left empty each follows the machine's answer above. What a project actually checks is read from its own workflows and commit hook, which Settings does not hold because they live in the repository.",
      keywords: ['project', 'projects', 'repository', 'repo', 'checks', 'budget', 'spend'],
      settings: projects.flatMap(([name, project]): Setting[] => [
        {
          path: `projects.${name}.root`,
          title: 'Where the repository is',
          means: `the checkout every agent in ${name} works in; moving it moves where all of them work`,
          value: project.root,
          fallback: '',
          type: { kind: 'text', placeholder: '~/src/app' } as const,
          live: false,
          scope: name,
        },
        {
          // A label and never the id (`ProjectConfigSchema.title`), said in
          // `means` too: this is where somebody types one and wonders what it
          // will move.
          path: `projects.${name}.title`,
          title: 'Shown as',
          means: `what to call ${name} on screen; its task ids, its commits and its journal keep the name ${name}`,
          value: project.title ?? '',
          fallback: name,
          type: { kind: 'text', placeholder: name } as const,
          live: true,
          keywords: ['rename', 'name', 'title', 'label'],
          scope: name,
        },
        {
          path: `projects.${name}.brief`,
          title: 'Brief',
          means: 'one line the orchestrator is told about this project',
          value: project.brief ?? '',
          fallback: 'none',
          type: { kind: 'text', placeholder: 'Payments. Stripe, Postgres, Node.' } as const,
          live: false,
          scope: name,
        },
        {
          // Empty follows the Agents setting: two projects on one machine want
          // different answers — agents side by side where work is sequential,
          // a worktree each where two efforts are unrelated — and tasks that
          // already exist keep the answer they were made with.
          path: `projects.${name}.workspace`,
          title: 'Where agents work',
          means: `checkout: all of ${name}'s agents in its own checkout at once; worktree: one each`,
          value: project.workspace ?? '',
          fallback: config.agents.workspace,
          type: { kind: 'choice', options: ['', ...AGENT_WORKSPACES] } as const,
          live: true,
          keywords: [name, 'workspace', 'worktree', 'checkout'],
          scope: name,
        },
        {
          // The one row here whose `means` changes with another setting, and
          // deliberately: `branch-and-review` needs a branch of the agent's
          // own, so in a project whose agents share its checkout it cannot
          // mean what it says. `pushFor` is the one place that decides, and
          // this is one of the three that say it — the page somebody sets it
          // on, `tade_settings` where the orchestrator reads the same row, and
          // `tade config --check` for a file written by hand.
          path: `projects.${name}.push`,
          title: 'What is pushed',
          means:
            pushFor(config, name, workspaceFor(config, name)).problem ??
            `never: nothing of ${name} reaches its remote; branch: agents push the branch they are on; branch-and-review: each pushes its own branch and opens a review on it, which needs a worktree each`,
          value: project.push ?? '',
          // What this project gets by saying nothing: the machine's answer
          // where there is one, and otherwise what this project's workspace
          // answers — never the bare word `never`, which is what a row with no
          // machine-wide setting used to read as in a worktree project that
          // pushes by default.
          fallback: config.agents.push ?? pushDefault(workspaceFor(config, name)),
          type: { kind: 'choice', options: ['', ...PUSH_MODES] } as const,
          live: true,
          keywords: [name, 'push', 'pushing', 'remote', 'review', 'pull request'],
          scope: name,
        },
        {
          // `budget` rather than the project's name, which the page says once
          // at the top: a title is what a refusal tells somebody to say back,
          // and a project's own name no longer names anything inside that
          // project (`wordsFor`), so "say app" was advice that did nothing.
          path: `projects.${name}.budget.usd_per_day`,
          title: 'Budget a day',
          means: 'dollars a day; agents are warned at 80% and refused past it',
          value:
            project.budget?.usd_per_day === undefined ? '' : String(project.budget.usd_per_day),
          fallback: 'no budget',
          type: { kind: 'number' } as const,
          live: false,
          keywords: ['budget', 'spend', 'money', 'dollars', 'cap'],
          scope: name,
        },
        // The schema has always allowed `projects.<name>.checks`, and
        // `checksFor` has always read it; until these rows there was no way to
        // set one, which made it a key that read like a promise Tade did not
        // keep.
        {
          path: `projects.${name}.checks.before`,
          title: 'Checks needed before',
          means: `when Tade runs ${name}'s checks unasked, whatever the rule above says; holding a push still needs approvals.mode policy`,
          value: project.checks?.before ?? '',
          fallback: config.checks.before,
          type: { kind: 'choice', options: ['', 'off', 'commit', 'push', 'commit and push'] },
          live: true,
          keywords: [name, 'checks', 'gate', 'push'],
          scope: name,
        },
        {
          path: `projects.${name}.checks.on_red`,
          title: 'When a check is red',
          means: `what a failed required check does in ${name}`,
          value: project.checks?.on_red ?? '',
          fallback: config.checks.on_red,
          type: { kind: 'choice', options: ['', 'hold', 'tell', 'note'] },
          live: true,
          keywords: [name, 'checks', 'red', 'fail'],
          scope: name,
        },
        {
          path: `projects.${name}.checks.parallel`,
          title: 'Checks at once',
          means: `how many of ${name}'s checks may run at once here`,
          value: project.checks?.parallel === undefined ? '' : String(project.checks.parallel),
          fallback: String(config.checks.parallel),
          type: { kind: 'number' } as const,
          live: true,
          keywords: [name, 'checks', 'parallel'],
          scope: name,
        },
        // One row per check somebody has answered about on the ACTIONS page —
        // and only those, because a check id is only knowable by reading the
        // repository and this function reads nothing. So this is where an
        // override is seen, searched for and undone; making a new one is the
        // page's, where the checks actually are.
        ...Object.entries(project.checks?.run_here ?? {}).map(
          ([id, runs]): Setting => ({
            path: `projects.${name}.checks.run_here.${id}`,
            title: `Run ${id} here`,
            means: `whether Tade runs ${name}'s ${id} check on this machine, over what its own CI and commit hook say`,
            value: String(runs),
            fallback: 'what the project says',
            type: { kind: 'flag' } as const,
            live: true,
            keywords: [name, 'checks', id, 'here', 'run'],
            scope: name,
          }),
        ),
      ]),
    },
  ]
}
