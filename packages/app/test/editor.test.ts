import { describe, expect, it } from 'vitest'
import {
  chooseEditor,
  editorWeAreIn,
  findOpenable,
  openerFor,
  openerForLink,
  openerForReveal,
} from '../src/editor.ts'

// Opening what you click. Which editor, with what arguments, and what on a
// screen counts as something to open — all without launching anything.

describe('choosing an editor', () => {
  it('uses the one the config names, whatever else is true', () => {
    expect(chooseEditor('zed', { TERM_PROGRAM: 'vscode', EDITOR: 'vim' }).editor).toBe('zed')
  })

  it('prefers the editor whose terminal Tade is running in', () => {
    expect(chooseEditor(undefined, { TERM_PROGRAM: 'vscode', EDITOR: 'vim' }).editor).toBe('code')
  })

  it('tells VS Code from the forks that call themselves VS Code', () => {
    expect(
      editorWeAreIn({
        TERM_PROGRAM: 'vscode',
        VSCODE_GIT_ASKPASS_NODE: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper',
      }),
    ).toBe('cursor')
    expect(
      editorWeAreIn({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.exafunction.windsurf' }),
    ).toBe('windsurf')
    expect(editorWeAreIn({ TERM_PROGRAM: 'vscode' })).toBe('code')
  })

  it('knows the other editors that have terminals', () => {
    expect(editorWeAreIn({ ZED_TERM: 'true' })).toBe('zed')
    expect(editorWeAreIn({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toBe('idea')
    expect(editorWeAreIn({ NVIM: '/tmp/nvim.sock' })).toBe('nvim')
    expect(editorWeAreIn({ INSIDE_EMACS: '29.1,vterm' })).toBe('emacs')
    expect(editorWeAreIn({ TERM_PROGRAM: 'Apple_Terminal' })).toBeNull()
  })

  it('falls back to $VISUAL, then $EDITOR, then the system', () => {
    expect(chooseEditor(undefined, { VISUAL: 'nvim', EDITOR: 'vim' }).editor).toBe('nvim')
    expect(chooseEditor(undefined, { EDITOR: '/usr/bin/vi' }).editor).toBe('vim')
    expect(chooseEditor(undefined, {}).editor).toBe('system')
  })
})

describe('opening a place', () => {
  const place = { file: '/src/app/webhooks.ts', line: 42, column: 7 }

  it('opens at the line and column in editors that take file:line:col', () => {
    expect(openerFor('code', place, {})).toEqual({
      kind: 'detached',
      command: 'code',
      args: ['-r', '-g', '/src/app/webhooks.ts:42:7'],
    })
    expect(openerFor('zed', place, {}).args).toEqual(['/src/app/webhooks.ts:42:7'])
  })

  it('uses each editor its own way', () => {
    expect(openerFor('idea', place, {}).args).toEqual(['--line', '42', '/src/app/webhooks.ts'])
    expect(openerFor('vim', place, {})).toEqual({
      kind: 'terminal',
      command: 'vim',
      args: ['+42', '/src/app/webhooks.ts'],
    })
  })

  it('opens in the nvim it is already running inside, rather than a second one', () => {
    const opener = openerFor('nvim', place, { NVIM: '/tmp/nvim.sock' })
    expect(opener.kind).toBe('detached')
    expect(opener.args).toContain('/tmp/nvim.sock')
  })

  it('runs a terminal editor in a terminal, never detached from one', () => {
    expect(openerFor('nvim', place, {}).kind).toBe('terminal')
    expect(openerFor('emacs', place, {}).kind).toBe('terminal')
  })

  it('opens links with what the system opens links with', () => {
    expect(openerForLink('https://example.com', 'darwin').command).toBe('open')
    expect(openerForLink('https://example.com', 'linux').command).toBe('xdg-open')
  })

  it('reveals a file in the folder it is in, picked out where the manager can', () => {
    expect(openerForReveal('/src/app/webhooks.ts', false, 'darwin')).toEqual({
      kind: 'detached',
      command: 'open',
      args: ['-R', '/src/app/webhooks.ts'],
    })
    // Nothing on Linux selects a file, so the folder is the honest answer.
    expect(openerForReveal('/src/app/webhooks.ts', false, 'linux').args).toEqual(['/src/app'])
  })

  it('reveals a folder as itself, since there is nothing to pick out of it', () => {
    expect(openerForReveal('/src/app', true, 'darwin').args).toEqual(['/src/app'])
    expect(openerForReveal('/src/app', true, 'linux').args).toEqual(['/src/app'])
  })
})

describe('what on screen can be opened', () => {
  it('finds links, without the punctuation after them', () => {
    const [found] = findOpenable('see https://docs.stripe.com/webhooks/signatures.')
    expect(found?.target).toEqual({
      kind: 'url',
      url: 'https://docs.stripe.com/webhooks/signatures',
    })
    expect(found?.from).toBe(4)
  })

  it('finds a file with its line and column', () => {
    const found = findOpenable('  error in src/webhooks.ts:42:7 — bad signature')
    expect(found).toHaveLength(1)
    expect(found[0]?.target).toEqual({
      kind: 'place',
      path: 'src/webhooks.ts',
      line: 42,
      column: 7,
    })
    expect('  error in src/webhooks.ts:42:7'.slice(found[0]?.from, (found[0]?.to ?? 0) + 1)).toBe(
      'src/webhooks.ts:42:7',
    )
  })

  // Two ways of writing a web address, and the line between them. `www.` is
  // unambiguous enough to be worth taking, and taking it is also what stops
  // the path pattern claiming `www.example.com` as a file nobody has. A bare
  // `example.com` is not: nothing tells it from `report.md`, and where Tade is
  // looking at a project a file is the better guess.
  it('takes a bare www. as a link, and opens it over https', () => {
    const [found] = findOpenable('see www.example.com/pricing for it')
    expect(found?.target).toEqual({ kind: 'url', url: 'https://www.example.com/pricing' })
    // The columns are the ones it was written in, not the ones it will open as.
    expect('see www.example.com/pricing'.slice(found?.from, (found?.to ?? 0) + 1)).toBe(
      'www.example.com/pricing',
    )
  })

  it('leaves a bare domain to be read as a file, which is what it looks like', () => {
    expect(findOpenable('open example.com now')[0]?.target).toEqual({
      kind: 'place',
      path: 'example.com',
    })
  })

  it('does not mistake a version or a sentence for a file', () => {
    expect(findOpenable('upgraded to 15.0.1 and it works.')).toEqual([])
  })
})
