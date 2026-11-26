import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { answerFor, isPrompt, rootsOf, scratchPlaces } from '../src/prompt.ts'

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
