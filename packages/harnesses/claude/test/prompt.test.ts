import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { answerFor, isPrompt, ownPlacesIn, rootsOf, scratchPlaces } from '../src/prompt.ts'

// What counts as the agent's own beside its workspace, as Claude Code lays it
// out: its scratchpads under /tmp/claude-*, and $TMPDIR, under both of the
// names macOS gives them.

describe('scratchPlaces', () => {
  it('names Claude Code’s scratchpads and $TMPDIR, each as macOS also spells it', () => {
    const places = scratchPlaces({ TMPDIR: '/var/folders/x1/abc/T/' })
    expect(places).toEqual(
      expect.arrayContaining([
        '/tmp/claude-*',
        '/private/tmp/claude-*',
        '/var/folders/x1/abc/T',
        '/private/var/folders/x1/abc/T',
      ]),
    )
    // This process's own too, which a window and the lane it drew need not share.
    expect(places).toContain(tmpdir().replace(/\/+$/, ''))
  })

  it('takes no TMPDIR that is not an absolute path', () => {
    expect(scratchPlaces({ TMPDIR: 'relative/tmp' })).not.toContain('relative/tmp')
  })
})

describe('answerFor', () => {
  it('allows a heredoc that edits the project and runs a helper from its scratchpad', async () => {
    const answer = await answerFor(
      'Bash',
      {
        command:
          "python3 /private/tmp/claude-501/-Users-sam-shop/0e1088a5/scratchpad/fix.py <<'EOF'\nsrc/money.ts\nEOF",
      },
      tmp('tade-claude-cwd-'),
    )
    expect(answer).toMatchObject({ allow: true, rule: 'in-workspace' })
  })
})

describe('ownPlacesIn', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is its project’s folder in Tade’s home, as a launch hands the home down', () => {
    expect(ownPlacesIn('tade/one-run', { TADE_HOME: '/h/.tade' })).toEqual([
      '/h/.tade/projects/tade',
    ])
    expect(ownPlacesIn('tade/one-run', { HOME: '/x' })[0]).toMatch(/\/\.tade\/projects\/tade$/)
    for (const task of [null, '', '../x', './x']) expect(ownPlacesIn(task, {})).toEqual([])
  })

  it('lets a hook’s own task cd into the batch tree, and not another project’s', async () => {
    // Outside every temporary folder, which is the agent's scratch anyway.
    const home = '/srv/tade-home'
    vi.stubEnv('TADE_HOME', home)
    vi.stubEnv('TADE_TASK_ID', 'tade/one-run-of-all-the-tests')
    const workspace = tmp('tade-claude-cwd-')
    const ours = await answerFor(
      'Bash',
      { command: `cd ${home}/projects/tade/batch && pnpm check` },
      workspace,
    )
    expect(ours).toMatchObject({ allow: true })
    const theirs = await answerFor(
      'Bash',
      { command: `cd ${home}/projects/bank/batch && ls` },
      workspace,
    )
    expect(theirs.allow).toBe(false)
    // Said outright, the task is the window's to name.
    const named = await answerFor(
      'Bash',
      { command: `ls ${home}/projects/bank` },
      workspace,
      null,
      'bank/x',
    )
    expect(named).toMatchObject({ allow: true })
  })
})

describe('rootsOf', () => {
  it('is the workspace alone where its .git is a folder in it', async () => {
    const cwd = tmp('tade-claude-cwd-')
    mkdirSync(join(cwd, '.git'))
    expect(await rootsOf(cwd)).toEqual([cwd])
  })

  it('adds the repository’s own git folder for a worktree, where its hooks are', async () => {
    const cwd = tmp('tade-claude-cwd-')
    const common = tmp('tade-claude-git-')
    mkdirSync(join(common, 'worktrees', 'refunds'), { recursive: true })
    writeFileSync(join(common, 'worktrees', 'refunds', 'commondir'), '../..\n')
    writeFileSync(join(cwd, '.git'), `gitdir: ${join(common, 'worktrees', 'refunds')}\n`)
    expect(await rootsOf(cwd)).toEqual([cwd, common])
  })
})

describe('isPrompt', () => {
  it('is a PermissionRequest carrying suggestions, which Claude Code builds a prompt with', () => {
    expect(isPrompt({ hook_event_name: 'PermissionRequest', permission_suggestions: [] })).toBe(
      true,
    )
    expect(isPrompt({ hook_event_name: 'PermissionRequest' })).toBe(false)
    expect(isPrompt({ hook_event_name: 'PreToolUse', permission_suggestions: [] })).toBe(false)
  })
})
