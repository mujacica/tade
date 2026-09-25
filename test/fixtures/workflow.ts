// A CI workflow, for tests about a project's checks.
//
// What a project checks is read out of the workflow that runs on every change,
// so a test about checks has to hand Tade one — and it has to look like one
// somebody would write, not like a list of commands with YAML around it. A
// fixture kinder than reality hides bugs: this one has the checkout and the
// install in it, because every real workflow does and because neither is a
// check, which is exactly the distinction the reading has to get right.

/** One step of the gate: the name is the check's id, the command is what runs. */
export interface Step {
  id: string
  run: string
  /** `timeout-minutes`, where the test is about that. */
  minutes?: number
  /** `continue-on-error`, for a step CI is willing to be red on. */
  soft?: boolean
}

/**
 * A workflow that checks exactly these, on every push and every pull request.
 *
 * Write it at `.github/workflows/ci.yml` and `readChecks` finds these steps in
 * this order, with the checkout and the install named as not-checks.
 */
export function ciWorkflow(steps: readonly Step[]): string {
  const lines = [
    'name: ci',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - run: pnpm install --frozen-lockfile',
  ]
  for (const step of steps) {
    lines.push(`      - name: ${step.id}`)
    if (step.minutes !== undefined) lines.push(`        timeout-minutes: ${step.minutes}`)
    if (step.soft) lines.push('        continue-on-error: true')
    lines.push(
      step.run.includes('\n')
        ? ['        run: |', ...step.run.split('\n').map((line) => `          ${line}`)].join('\n')
        : `        run: ${step.run}`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** Where a workflow goes, so no test spells the path itself. */
export const CI_WORKFLOW = '.github/workflows/ci.yml'
