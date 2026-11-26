import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { answerPrompt, type PromptFacts, type ToolEffect } from '../src/policy.ts'

// A harness's own yes/no, answered by rule: what stays in the workspace is
// allowed, and each class of refusal the person named is refused with a reason.

const HOME = '/Users/sam'
const WORK = '/Users/sam/code/shop/.tade-worktrees/refunds'
const GIT = '/Users/sam/code/shop/.git'

const TMP = '/var/folders/x1/abc/T'
const facts = (tool: string, effect: ToolEffect, input: unknown): PromptFacts => ({
  tool,
  input,
  effect,
  roots: [WORK, GIT],
  scratch: ['/tmp/claude-*', '/private/tmp/claude-*', TMP],
  cwd: WORK,
  home: HOME,
})
const bash = (command: string) => answerPrompt(facts('Bash', 'exec', { command }))
const write = (file_path: string) => answerPrompt(facts('Write', 'write', { file_path }))

describe('answerPrompt allows what stays inside the workspace', () => {
  it.each([
    ['edits a hook in its repository', () => write(`${GIT}/hooks/pre-commit`)],
    ['edits the worktree by an absolute path', () => write(`${WORK}/.claude/settings.json`)],
    ['edits by a relative path', () => write('.git/hooks/pre-push')],
    ['removes build output', () => bash('rm -rf dist node_modules/.cache')],
    ['removes build output by its absolute path', () => bash(`rm -rf ${WORK}/build`)],
    ['writes to /dev/null', () => bash('make clean > /dev/null 2>&1')],
    ['pushes without force', () => bash('git push -u origin feat --follow-tags')],
    ['names an address, not a path', () => bash('curl -sS https://example.com/x -o out.json')],
    ['names an example env file', () => write('.env.example')],
    ['makes a tag', () => bash('git tag -a v1.2.0 -m "Release"')],
    ['lists branches sorted', () => bash('git branch -a --sort=-committerdate')],
    // The harness's own scratch and temporary folders are the agent's too: a
    // heredoc editing the project and running a helper from its scratchpad
    // was refused, live, before they were.
    [
      'runs a helper from its scratchpad while editing the project',
      () =>
        bash(
          `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['python3', '/private/tmp/claude-501/-Users-sam-shop/0e1088a5/scratchpad/fix.py', 'src/money.ts'])\nEOF`,
        ),
    ],
    ['writes to a scratchpad under /tmp', () => write('/tmp/claude-501/s/scratchpad/notes.md')],
    ['writes to $TMPDIR by its path', () => write(`${TMP}/build.log`)],
    ['writes to $TMPDIR by its name', () => bash('sort out.txt > "$TMPDIR/sorted.txt"')],
    // Only the command's own arguments are judged: a heredoc's body and a
    // quoted script are text a program reads. Refused live, at 23:22, for an
    // import path inside a Python edit.
    [
      'edits a file whose text names a path outside, by a heredoc',
      () =>
        bash(
          `python3 - <<'EOF'\ns = open('src/pay.ts').read().replace("from '../bank/money.ts'", "from '../../bank/money.ts'")\nopen('/etc/hosts').read()\nEOF`,
        ),
    ],
    [
      'runs a quoted script that names a path',
      () => bash(`python3 -c "print(open('/etc/hosts').read())"`),
    ],
    [
      'writes text that says sudo and .env',
      () => bash(`cat > notes.md <<EOF\nRun sudo make install; never commit .env\nEOF`),
    ],
    [
      'commits with a message about force pushes',
      () => bash('git commit -m "Never git push --force to main"'),
    ],
    ['names a path built from a variable', () => bash('cp "$OUT/report.json" build/')],
    // Refused live at 23:26: a regex in a heredoc's body, and the same as an argument.
    [
      'edits with a regex in a heredoc',
      () =>
        bash(`python3 - <<'EOF'\nimport re\ns = re.sub(r'/\\B', '', open('src/a.ts').read())\nEOF`),
    ],
    ['greps for a regex that starts with a slash', () => bash(`grep -rnE '/\\B' src`)],
    ['names a glob', () => bash('ls /src/*.ts')],
    [
      'moves first, so its relative paths cannot be placed',
      () => bash('cd src/deep && rm -rf ../../build'),
    ],
    [
      'climbs only within the workspace from where it stands',
      () =>
        answerPrompt({
          ...facts('Bash', 'exec', { command: 'cat ../README.md' }),
          cwd: `${WORK}/src`,
        }),
    ],
  ])('%s', (_name, answer) => {
    expect(answer()).toEqual({
      allow: true,
      rule: 'in-workspace',
      reason: 'it stays inside its own workspace',
    })
  })
})

describe('answerPrompt refuses, with a reason the agent reads', () => {
  it.each([
    // Outside the project.
    ['an absolute path elsewhere', () => bash('rm -rf /var/lib/thing'), 'outside'],
    ['climbing out of the workspace', () => bash('rm -rf ../../other'), 'home'],
    ['a write elsewhere', () => write('/etc/hosts'), 'outside'],
    ['another repository by -C', () => bash('git -C /srv/other commit -m x'), 'outside'],
    ['a flag pointing elsewhere', () => bash('git --git-dir=/srv/x/.git log'), 'outside'],
    // Force-pushes, and deleting branches or tags.
    ['--force', () => bash('git push --force origin main'), 'force-push'],
    ['--force-with-lease', () => bash('git push --force-with-lease'), 'force-push'],
    ['-f', () => bash('git push origin main -f'), 'force-push'],
    ['a + refspec', () => bash('git push origin +main'), 'force-push'],
    ['branch -D', () => bash('git branch -D old'), 'ref-delete'],
    ['branch --delete', () => bash('git branch --delete old'), 'ref-delete'],
    ['tag -d', () => bash('git tag -d v1'), 'ref-delete'],
    ['push --delete', () => bash('git push origin --delete old'), 'ref-delete'],
    ['push :ref', () => bash('git push origin :old'), 'ref-delete'],
    // Keys, credentials, Tade's config, shell rc files and the home folder.
    ['a private key', () => bash('cat ~/.ssh/id_ed25519'), 'credentials'],
    ['~/.ssh', () => write(`${HOME}/.ssh/config`), 'credentials'],
    ['~/.npmrc', () => bash('echo //registry/:_authToken=x >> ~/.npmrc'), 'credentials'],
    ['an env file in the project', () => bash('cat .env'), 'credentials'],
    ['Tade’s config', () => write(`${HOME}/.tade/config.yaml`), 'credentials'],
    ['.zshrc', () => bash('echo "export X=1" >> ~/.zshrc'), 'shell-rc'],
    ['.bash_profile', () => write(`${HOME}/.bash_profile`), 'shell-rc'],
    ['the home folder by ~', () => bash('rm -rf ~/Downloads/x'), 'home'],
    ['the home folder by $HOME', () => bash('touch $HOME/x'), 'home'],
    ['the home folder by its path', () => write(`${HOME}/notes.txt`), 'home'],
    // Root.
    ['sudo', () => bash('sudo rm -rf build'), 'sudo'],
    ['sudo after another command', () => bash('make && sudo make install'), 'sudo'],
  ])('%s', (_name, answer, rule) => {
    const answered = answer()
    expect(answered.allow).toBe(false)
    expect(answered.rule).toBe(rule)
    expect(answered.reason).toMatch(/^it /)
  })

  it('keeps to the harness’s own scratch folders, and never lets keys through them', () => {
    // Another program's folder in /tmp is not the agent's.
    expect(bash('rm -rf /tmp/other-tool/cache')).toMatchObject({ allow: false, rule: 'outside' })
    // `claude-` with no name after it is no scratchpad, nor is a climb out of one.
    expect(write('/tmp/claude-')).toMatchObject({ allow: false, rule: 'outside' })
    expect(write('/tmp/claude-501/../../etc/hosts')).toMatchObject({ allow: false })
    // A key copied into a scratchpad is still a key.
    expect(bash('cp ~/.ssh/id_ed25519 /tmp/claude-501/k')).toMatchObject({ rule: 'credentials' })
    // Without any scratch places named, nothing outside the workspace is the agent's.
    const bare = answerPrompt({
      ...facts('Write', 'write', {}),
      input: { file_path: `${TMP}/x` },
      scratch: [],
    })
    expect(bare).toMatchObject({ allow: false, rule: 'outside' })
  })

  it('lets a relative path be when it does not know where the agent stands', () => {
    const unknown = answerPrompt({
      ...facts('Bash', 'exec', { command: 'rm -rf ../../x' }),
      cwd: null,
    })
    expect(unknown.allow).toBe(true)
  })

  it('still judges what follows a heredoc on its own line', () => {
    expect(bash(`cat <<EOF > out.txt\nhello\nEOF\nsudo rm -rf build`)).toMatchObject({
      rule: 'sudo',
    })
    expect(bash(`cat <<'EOF' > ~/.zshrc\nexport X=1\nEOF`)).toMatchObject({
      allow: false,
      rule: 'shell-rc',
    })
  })

  it('refuses a home-relative path when nobody knows where home is', () => {
    const answered = answerPrompt({ ...facts('Write', 'write', { file_path: '~/x' }), home: null })
    expect(answered).toMatchObject({ allow: false, rule: 'home' })
  })

  it('refuses a relative path when there is no workspace to read it against', () => {
    const answered = answerPrompt({ ...facts('Write', 'write', { file_path: 'x' }), roots: [] })
    expect(answered.allow).toBe(false)
  })

  it('reads a command off a tool that is not an exec one', () => {
    const answered = answerPrompt(facts('mcp__x__run', 'other', { command: 'sudo ls' }))
    expect(answered).toMatchObject({ allow: false, rule: 'sudo' })
  })
})

describe('policy.ts', () => {
  // A Claude Code hook answers by this rule on its own when Tade cannot be
  // asked, and a hook runs under Claude Code's module resolution, where
  // nothing of ours resolves: so the file it imports takes only Node's own.
  it('imports nothing but Node built-ins', () => {
    const source = readFileSync(new URL('../src/policy.ts', import.meta.url), 'utf8')
    const from = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((one) => one[1])
    expect(from.length).toBeGreaterThan(0)
    for (const specifier of from) expect(specifier).toMatch(/^node:/)
  })
})
