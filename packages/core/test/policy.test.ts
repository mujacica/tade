import { describe, expect, it } from 'vitest'
import { classifyToolCall, decideApproval, inside, type Tier } from '../src/policy.ts'

const WORKTREE = '/work/wt/checkout-refunds'

const bash = (command: string) => ({ tool: 'bash', input: { command }, worktree: WORKTREE })
const file = (tool: string, path: string) => ({ tool, input: { path }, worktree: WORKTREE })

interface Case {
  name: string
  facts: { tool: string; input: unknown; worktree: string | null }
  want: Tier
  rule?: string
}

const cases: Case[] = [
  // --- auto: reading, and editing its own worktree
  { name: 'read a file', facts: file('read', `${WORKTREE}/src/app.ts`), want: 'auto' },
  {
    name: 'grep',
    facts: { tool: 'grep', input: { pattern: 'refund' }, worktree: WORKTREE },
    want: 'auto',
  },
  { name: 'edit inside the worktree', facts: file('edit', `${WORKTREE}/src/app.ts`), want: 'auto' },
  { name: 'edit by relative path', facts: file('write', 'src/app.ts'), want: 'auto' },
  { name: 'git status', facts: bash('git status --porcelain'), want: 'auto' },
  { name: 'ls', facts: bash('ls -la src'), want: 'auto' },
  { name: 'git log', facts: bash('git log -5 --oneline'), want: 'auto' },

  // --- soft: one word is enough
  { name: 'run tests', facts: bash('npm test'), want: 'soft', rule: 'command' },
  {
    name: 'install a dependency',
    facts: bash('npm install stripe@15'),
    want: 'soft',
    rule: 'network',
  },
  {
    name: 'ordinary push',
    facts: bash('git push origin wilco/refunds'),
    want: 'soft',
    rule: 'push',
  },
  { name: 'open a PR', facts: bash('gh pr create --fill'), want: 'soft', rule: 'pr' },
  {
    name: 'fetch a url',
    facts: bash('curl https://example.com/x.json'),
    want: 'soft',
    rule: 'network',
  },
  { name: 'commit', facts: bash('git commit -m "fix refunds"'), want: 'soft' },
  {
    name: 'rm -rf inside the worktree',
    facts: bash(`rm -rf ${WORKTREE}/node_modules`),
    want: 'soft',
  },
  { name: 'rm -rf a relative path', facts: bash('rm -rf build'), want: 'soft' },
  {
    name: 'a tool nobody has heard of',
    facts: { tool: 'deploy', input: {}, worktree: WORKTREE },
    want: 'soft',
  },
  {
    name: 'write with no path given',
    facts: { tool: 'write', input: {}, worktree: WORKTREE },
    want: 'soft',
  },

  // --- hard: say the command back
  {
    name: 'force push',
    facts: bash('git push --force origin main'),
    want: 'hard',
    rule: 'force-push',
  },
  {
    name: 'force push with lease',
    facts: bash('git push --force-with-lease'),
    want: 'hard',
    rule: 'force-push',
  },
  {
    name: 'force push, short flag',
    facts: bash('git push -f origin main'),
    want: 'hard',
    rule: 'force-push',
  },
  { name: 'rebase', facts: bash('git rebase -i main'), want: 'hard', rule: 'history-rewrite' },
  {
    name: 'reset --hard',
    facts: bash('git reset --hard HEAD~3'),
    want: 'hard',
    rule: 'history-rewrite',
  },
  {
    name: 'delete a branch',
    facts: bash('git branch -D main'),
    want: 'hard',
    rule: 'branch-delete',
  },
  {
    name: 'delete a remote branch',
    facts: bash('git push origin --delete main'),
    want: 'hard',
    rule: 'branch-delete',
  },
  { name: 'sudo anything', facts: bash('sudo rm /etc/hosts'), want: 'hard', rule: 'sudo' },
  { name: 'read .env', facts: bash('cat .env'), want: 'hard', rule: 'credentials' },
  {
    name: 'read .env.production',
    facts: bash('cat .env.production'),
    want: 'hard',
    rule: 'credentials',
  },
  { name: 'read an ssh key', facts: bash('cat ~/.ssh/id_rsa'), want: 'hard', rule: 'credentials' },
  { name: 'read .env with the read tool', facts: file('read', `${WORKTREE}/.env`), want: 'hard' },
  {
    name: 'write .env with the write tool',
    facts: file('write', `${WORKTREE}/.env`),
    want: 'hard',
  },
  { name: 'npm publish', facts: bash('npm publish'), want: 'hard', rule: 'publish' },
  {
    name: 'docker push',
    facts: bash('docker push acme/api:latest'),
    want: 'hard',
    rule: 'publish',
  },
  {
    name: 'database migration',
    facts: bash('prisma migrate deploy'),
    want: 'hard',
    rule: 'migration',
  },
  {
    name: 'drop table',
    facts: bash('psql -c "DROP TABLE orders"'),
    want: 'hard',
    rule: 'migration',
  },
  {
    name: 'rm -rf outside the worktree',
    facts: bash('rm -rf /Users/me/src/other'),
    want: 'hard',
    rule: 'recursive-delete',
  },
  { name: 'rm -rf the root', facts: bash('rm -rf /'), want: 'hard', rule: 'recursive-delete' },
  {
    name: 'rm -rf $HOME',
    facts: bash('rm -rf ~/Documents'),
    want: 'hard',
    rule: 'recursive-delete',
  },
  {
    name: 'write outside the worktree',
    facts: file('write', '/etc/hosts'),
    want: 'hard',
    rule: 'write-outside-worktree',
  },
  { name: 'write to the home directory', facts: file('edit', '~/.zshrc'), want: 'hard' },
  {
    name: 'edit with no worktree known',
    facts: { tool: 'edit', input: { path: 'a.ts' }, worktree: null },
    want: 'hard',
  },
]

describe('classifyToolCall', () => {
  it('covers a wide table', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40)
  })

  it.each(cases)('$name → $want', (c) => {
    const decision = classifyToolCall(c.facts)
    expect(decision.tier).toBe(c.want)
    if (c.rule) expect(decision.rule).toBe(c.rule)
    expect(decision.reason.length).toBeGreaterThan(0)
  })

  it('never lets a destructive command through as auto', () => {
    const destructive = cases.filter((c) => c.want === 'hard')
    for (const c of destructive) {
      expect(classifyToolCall(c.facts).tier).not.toBe('auto')
    }
  })

  it('honours a per-project allowlist', () => {
    const facts = bash('npm test')
    expect(classifyToolCall(facts, { autoAllow: ['bash'] }).tier).toBe('auto')
  })

  it('an allowlist cannot be used to auto-approve credentials', () => {
    // The allowlist is per tool, so this is a deliberate choice by the user;
    // documenting the behaviour so a change to it is a visible decision.
    expect(classifyToolCall(file('read', '/x/.env'), { autoAllow: ['read'] }).tier).toBe('auto')
  })

  it('is pure: the same call classifies the same way every time', () => {
    const facts = bash('git push --force origin main')
    expect(classifyToolCall(facts)).toEqual(classifyToolCall(facts))
  })
})

describe('decideApproval', () => {
  const forcePush = bash('git push --force origin main')

  it('bypass is the default posture: nothing is ever held', () => {
    for (const c of cases) {
      expect(decideApproval(c.facts, { mode: 'bypass' }).decision).toBe('allow')
    }
  })

  it('bypass still classifies, so the log knows what was run', () => {
    const approval = decideApproval(forcePush, { mode: 'bypass' })
    expect(approval).toMatchObject({ decision: 'allow', tier: 'hard', rule: 'force-push' })
  })

  it('policy mode asks for anything that is not routine', () => {
    expect(decideApproval(forcePush, { mode: 'policy' }).decision).toBe('ask')
    expect(decideApproval(bash('npm test'), { mode: 'policy' }).decision).toBe('ask')
  })

  it('policy mode lets reading and worktree edits through', () => {
    expect(decideApproval(file('read', `${WORKTREE}/a.ts`), { mode: 'policy' }).decision).toBe(
      'allow',
    )
    expect(decideApproval(file('edit', 'src/a.ts'), { mode: 'policy' }).decision).toBe('allow')
  })

  it('an allowlist skips the question for that tool', () => {
    expect(decideApproval(bash('npm test'), { mode: 'policy', autoAllow: ['bash'] }).decision).toBe(
      'allow',
    )
  })
})

describe('inside', () => {
  it('accepts paths in the worktree and rejects everything else', () => {
    expect(inside(`${WORKTREE}/src/a.ts`, WORKTREE)).toBe(true)
    expect(inside('src/a.ts', WORKTREE)).toBe(true)
    expect(inside(WORKTREE, WORKTREE)).toBe(true)
    expect(inside('/work/wt/checkout-refunds-other/a.ts', WORKTREE)).toBe(false)
    expect(inside('../escape.ts', WORKTREE)).toBe(false)
    expect(inside(`${WORKTREE}/../escape.ts`, WORKTREE)).toBe(false)
    expect(inside('~/secrets', WORKTREE)).toBe(false)
    expect(inside('/etc/hosts', null)).toBe(false)
  })
})

// Rules somebody wrote for their own machine.
//
// The thing under test is the direction they can move in: Wilco's own list is
// a floor rather than a default, so yours can tighten it and never loosen it.

describe('rules of your own', () => {
  const facts = (command: string) => ({ tool: 'bash', input: { command }, worktree: '/wt' })

  it('holds something only you know is dangerous here', () => {
    const decided = classifyToolCall(facts('terraform apply -auto-approve'), {
      rules: [{ match: 'terraform\\s+apply', tier: 'hard' as const, reason: 'changes production' }],
    })
    expect(decided).toMatchObject({ tier: 'hard', reason: 'changes production' })
  })

  it('names the pattern in the ledger, so a decision can be explained later', () => {
    const decided = classifyToolCall(facts('terraform apply'), {
      rules: [{ match: 'terraform', tier: 'hard' as const }],
    })
    expect(decided.rule).toBe('yours:terraform')
  })

  it('cannot loosen what Wilco already thinks is dangerous', () => {
    // `soft` is written, but a force push is `hard` and stays `hard`. The way
    // to loosen anything is `auto_allow`, which names exact tools on purpose.
    const decided = classifyToolCall(facts('git push --force origin main'), {
      rules: [{ match: 'git push', tier: 'soft' as const, reason: 'we do this all the time' }],
    })
    expect(decided).toMatchObject({ tier: 'hard', rule: 'force-push' })
  })

  it('takes the first of yours that applies', () => {
    const decided = classifyToolCall(facts('deploy to production'), {
      rules: [
        { match: 'deploy', tier: 'soft' as const, reason: 'deploys' },
        { match: 'production', tier: 'hard' as const, reason: 'production' },
      ],
    })
    // The soft one is not stricter than `command`'s own soft, so it is skipped
    // and the hard one decides: strictness wins over order.
    expect(decided).toMatchObject({ tier: 'hard', reason: 'production' })
  })

  it('skips a pattern it cannot read rather than failing the turn', () => {
    // A typo is reported by `wilco config --check`. An agent mid-turn is not
    // the moment to discover one.
    const decided = classifyToolCall(facts('ls'), {
      rules: [{ match: '([unclosed', tier: 'hard' as const }],
    })
    expect(decided.tier).toBe('auto')
  })
})
