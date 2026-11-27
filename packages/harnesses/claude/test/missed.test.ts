import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  answeredIn,
  answeredPath,
  leave,
  leaveAnswer,
  missedIn,
  missedPath,
  takeAnswered,
  takeMissed,
} from '../src/missed.ts'

// What a hook leaves when nobody heard it, and what the adapter taking the run
// back takes. The hook runs it as a process of Claude Code's (`hook.ts`), so
// the round trip is in `adapter.test.ts`; this is the record itself.

const socket = () => join(tmp('tcc-missed-'), 'c-0123456789ab.sock')

describe('a turn nobody heard end', () => {
  it('is kept, the last of however many, and a turn begun after it is written on it', async () => {
    const at = socket()
    leave(at, { hook_event_name: 'Stop', last_assistant_message: 'one' }, 1_000)
    leave(at, { hook_event_name: 'UserPromptSubmit', prompt: 'next' }, 2_000)
    leave(at, { hook_event_name: 'StopFailure', error: 'overloaded' }, 3_000)
    expect(await takeMissed(at)).toEqual({
      at: 3_000,
      event: { hook_event_name: 'StopFailure', error: 'overloaded' },
    })
    leave(at, { hook_event_name: 'Stop' }, 4_000)
    leave(at, { hook_event_name: 'UserPromptSubmit', prompt: 'again' }, 5_000)
    expect(await takeMissed(at)).toMatchObject({ at: 4_000, began: 5_000 })
  })

  it('is taken once, and nothing else a hook says is kept', async () => {
    const at = socket()
    // A turn begun with no unheard end before it, a tool call, a notification:
    // none of them is a turn ending that a window must be told of.
    leave(at, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    leave(at, { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    leave(at, { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(existsSync(missedPath(at))).toBe(false)
    expect(await takeMissed(at)).toBeNull()
    leave(at, { hook_event_name: 'Stop' })
    expect(await takeMissed(at)).not.toBeNull()
    expect(await takeMissed(at)).toBeNull()
  })

  it('is kept where only its owner can read it, and made where the folder has gone', () => {
    const at = join(tmp('tcc-missed-'), 'gone', 'c-0123456789ab.sock')
    leave(at, { hook_event_name: 'Stop' })
    expect(readFileSync(missedPath(at), 'utf8')).toContain('"Stop"')
    expect(statSync(missedPath(at)).mode & 0o777).toBe(0o600)
    expect(statSync(join(at, '..')).mode & 0o777).toBe(0o700)
  })

  it('never throws from a hook, and says why where it cannot be kept', () => {
    const dir = tmp('tcc-missed-')
    mkdirSync(join(dir, 'locked'))
    chmodSync(join(dir, 'locked'), 0o500)
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => leave(join(dir, 'locked', 's.sock'), { hook_event_name: 'Stop' })).not.toThrow()
      expect(said).toHaveBeenCalledWith(expect.stringContaining('could not keep a turn'))
    } finally {
      said.mockRestore()
    }
  })

  it('says what was left is not a record, rather than that no turn ended, and takes it all the same', async () => {
    const at = socket()
    mkdirSync(join(at, '..'), { recursive: true })
    writeFileSync(missedPath(at), 'not json')
    await expect(takeMissed(at)).rejects.toThrow(`${missedPath(at)} is not a turn that ended`)
    expect(existsSync(missedPath(at))).toBe(false)
    expect(await takeMissed(at)).toBeNull()
    for (const text of ['[]', '{"at":"soon","event":{}}', '{"at":1,"event":[]}', '{"at":1}']) {
      expect(missedIn(text)).toBeNull()
    }
    expect(missedIn('{"at":1,"event":{},"began":"later"}')).toEqual({ at: 1, event: {} })
  })
})

describe('a permission prompt answered with nobody to hear it', () => {
  const refused = { allowed: false, rule: 'outside', reason: 'it writes outside the workspace' }
  const allowed = { allowed: true, rule: 'inside', reason: 'it stays in the workspace' }

  it('is kept, every one in the order answered, and taken once', async () => {
    const at = socket()
    leaveAnswer(at, { tool: 'Bash', input: { command: 'rm -rf /' }, answered: refused }, 1_000)
    leaveAnswer(at, { tool: 'Write', input: { file_path: '.git/x' }, answered: allowed }, 2_000)
    expect(statSync(answeredPath(at)).mode & 0o777).toBe(0o600)
    expect(await takeAnswered(at)).toEqual({
      answered: [
        { at: 1_000, tool: 'Bash', input: { command: 'rm -rf /' }, answered: refused },
        { at: 2_000, tool: 'Write', input: { file_path: '.git/x' }, answered: allowed },
      ],
      unread: 0,
    })
    expect(existsSync(answeredPath(at))).toBe(false)
    expect(await takeAnswered(at)).toEqual({ answered: [], unread: 0 })
  })

  it('counts a line that is not one, rather than passing over it, and keeps the rest', async () => {
    const at = socket()
    leaveAnswer(at, { tool: 'Bash', input: {}, answered: allowed }, 1_000)
    writeFileSync(answeredPath(at), `${readFileSync(answeredPath(at), 'utf8')}{"at":\n[]\n`)
    expect(await takeAnswered(at)).toMatchObject({ answered: [{ at: 1_000 }], unread: 2 })
    for (const line of ['{"at":1,"tool":"Bash"}', '{"at":1,"tool":2,"answered":{}}']) {
      expect(answeredIn(line)).toBeNull()
    }
  })

  it('never throws from a hook, and says why where it cannot be kept', () => {
    const dir = tmp('tcc-missed-')
    mkdirSync(join(dir, 'locked'))
    chmodSync(join(dir, 'locked'), 0o500)
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() =>
        leaveAnswer(join(dir, 'locked', 's.sock'), { tool: 'Bash', input: {}, answered: allowed }),
      ).not.toThrow()
      expect(said).toHaveBeenCalledWith(
        expect.stringContaining('could not keep a permission prompt'),
      )
    } finally {
      said.mockRestore()
    }
  })
})
