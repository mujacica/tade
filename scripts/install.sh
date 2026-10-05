#!/bin/sh
#
# What `curl -fsSL https://tade.sh/install.sh | sh` runs.
#
# There is no binary to download and nothing here fetches one. Tade is an npm
# package called `tade-sh`, and this installs it with whichever of npm, pnpm or
# bun the machine has — so every single thing it does, somebody could do by
# hand in one line. Which is the whole argument for printing that line before
# running it: a script piped into a shell is a script nobody read, and the one
# thing this must never be is a program whose effect you have to take on trust.
#
# Five rules, held to by `test/install.test.ts`:
#
#   1. It prints the exact command before it runs it, and installs nothing it
#      did not print.
#   2. It never prompts. `curl … | sh` gives the shell its stdin, so there is
#      no terminal left to read an answer from and a question here is a hang.
#      Anything that would be a choice is a flag instead, with a default.
#   3. It changes nothing of the machine's but what the package manager
#      changes. No sudo, no shell rc file, no PATH written behind somebody's
#      back — where the command lands off PATH it says which directory and
#      what to add.
#   4. Nothing happens until the last line, which is why everything below is
#      a definition and `main "$@"` is at the bottom. A pipe that is cut off
#      halfway hands the shell whatever arrived, and a half-downloaded script
#      that defines some functions and stops does nothing at all.
#   5. It is readable. The budget in the test is on the lines that *do*
#      something, so explaining itself costs nothing and a wall of shell is
#      still a wall.
#
#   sh install.sh [--npm | --pnpm | --bun] [--version X.Y.Z] [--dry-run]
#
# Through the pipe, arguments go after `-s --`, or in the environment:
#
#   curl -fsSL https://tade.sh/install.sh | sh -s -- --pnpm
#   curl -fsSL https://tade.sh/install.sh | TADE_INSTALL_VERSION=0.2.0 sh
#
# Windows is not here on purpose. There is no `install.ps1`, because `tade`
# would install on Windows and then not run: a lane is `/bin/sh`, setup can
# only offer brew, apt and dnf, and CI never looks. The recipe
# (`.claude/skills/cut-a-release/`) carries the four things that have to change
# before a PowerShell line is an honest offer rather than a failure somebody
# finds after installing.

set -eu

# The package npm has, and the command it installs. `tade` was taken.
PACKAGE='tade-sh'
COMMAND='tade'

# The Node Tade needs, as `engines.node` declares it. Written out rather than
# read, because this script runs where that file is not — and `test/install.test.ts`
# holds the two to each other, so they cannot drift apart.
NEEDS_NODE='22.19'

# The two native dependencies, and the whole reason this script has anything
# to say about install scripts at all (see `approval_for`).
PTY='node-pty'
SQLITE='better-sqlite3'

say() { printf '%s\n' "$*"; }

# Everything that stops goes to stderr and says what to do about it: the last
# line of a failed install is the only line anybody reads.
die() { printf '%s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  say "Install Tade — the command \`$COMMAND\`, from the npm package \`$PACKAGE\`."
  say ''
  say "  --npm | --pnpm | --bun   install with this one (default: npm, or the first that is here)"
  say '  --version X.Y.Z          install this version (default: the newest published)'
  say '  --dry-run                print the command and stop'
  say ''
  say 'Needs Node >= '"$NEEDS_NODE"' and one of npm, pnpm or bun.'
}

# What to pass so that the install scripts actually run.
#
# Two of Tade's dependencies are native: node-pty, which is every terminal it
# opens, and better-sqlite3. On Linux node-pty is compiled during the install;
# on macOS it arrives prebuilt and its `spawn-helper` comes out of the tarball
# without its executable bit, which `tade-sh`'s own postinstall puts back. So
# an install whose scripts were held is an install that goes green and a `tade`
# that cannot open a terminal — the worst shape a failure has, because nothing
# says a word until the first lane.
#
# All three managers hold a dependency's scripts by default now, and each has
# its own way of being told otherwise. bun is the odd one: node-pty and
# better-sqlite3 are both on its own default trusted list, so the two that
# matter run anyway, and `--trust` is for `tade-sh` itself.
#
# Three names and no more. All three managers also warn about `@google/genai`,
# `esbuild` and `protobufjs`, none of which Tade needs built — esbuild's binary
# comes from its own platform package and transforms fine with its postinstall
# skipped (measured, 0.28.2, 2026-10-05). A list grown to quiet a warning is a
# list that approves somebody else's code for no reason.
approval_for() {
  case "$1" in
    npm)
      if npm_allows_scripts; then
        printf -- '--allow-scripts=%s,%s,%s' "$PACKAGE" "$PTY" "$SQLITE"
      fi
      ;;
    pnpm) printf -- '--allow-build=%s --allow-build=%s --allow-build=%s' "$PACKAGE" "$PTY" "$SQLITE" ;;
    bun) printf -- '--trust' ;;
  esac
}

# npm learnt `--allow-scripts` in 11.19, along with the policy that made it
# necessary; an older npm ran a dependency's scripts anyway. Passing it there
# would be a warning about an unknown config and a flag that does nothing, so
# it goes only where it is understood.
npm_allows_scripts() {
  npm_version="$(npm --version 2>/dev/null)" || return 1
  npm_major="${npm_version%%.*}"
  npm_minor="${npm_version#*.}"
  npm_minor="${npm_minor%%.*}"
  case "$npm_major.$npm_minor" in
    [0-9]*.[0-9]*) ;;
    *) return 1 ;;
  esac
  if [ "$npm_major" -gt 11 ]; then return 0; fi
  [ "$npm_major" -eq 11 ] && [ "$npm_minor" -ge 19 ]
}

# Where the command went, and what to do next. A global install that is not on
# PATH is the one failure left after a green install, and common enough on a
# fresh machine to answer here rather than leaving somebody with
# `tade: command not found`.
report() {
  say ''
  # What `$COMMAND` resolves to, rather than "the version I just installed":
  # where an older copy from another manager shadows this one, the number a
  # person reads here is the one they will actually get.
  if have "$COMMAND"; then
    say "Done. \`$COMMAND\` on your PATH is $("$COMMAND" --version), at $(command -v "$COMMAND")."
    say ''
    say "Run \`$COMMAND\`. The first run is a short setup: it looks at the machine, offers"
    say 'the exact command for anything missing, and ends by opening a terminal to prove it.'
    return 0
  fi
  case "$1" in
    npm) bin="$(npm prefix --global 2>/dev/null)/bin" ;;
    pnpm) bin="$(pnpm bin --global 2>/dev/null)" ;;
    bun) bin="$(bun pm bin --global 2>/dev/null)" ;;
  esac
  say "Installed, but \`$COMMAND\` is not on your PATH. $1 put it in"
  say ''
  say "  ${bin:-wherever $1 keeps its global bin directory}"
  say ''
  say "Add that to PATH in your shell profile, then run \`$COMMAND\`."
}

main() {
  # What was asked for, in the environment, which is the only way to ask
  # through a pipe without `sh -s --`. A flag below overrides either.
  manager="${TADE_INSTALL_WITH:-}"
  version="${TADE_INSTALL_VERSION:-}"
  dry=''

  while [ $# -gt 0 ]; do
    case "$1" in
      --npm | --pnpm | --bun) manager="${1#--}" ;;
      --version)
        [ $# -ge 2 ] || die 'install: --version wants a version, as in --version 0.2.0'
        version="$2"
        shift
        ;;
      --version=*) version="${1#--version=}" ;;
      --dry-run) dry='yes' ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "install: I do not know what $1 means. --help says what this takes." ;;
    esac
    shift
  done

  case "$manager" in
    '' | npm | pnpm | bun) ;;
    *) die "install: there is no --$manager. --help says what this takes." ;;
  esac

  # Node, and new enough.
  #
  # The one thing worth checking before the install rather than after it. Every
  # other way this can go wrong says something itself — `tade` at the door
  # refuses an old Node by name, and a native module that did not build is
  # answered in words — but a machine with no Node has no npm either, and
  # `sh: npm: command not found` is an answer to nobody.
  have node || die "Tade is a Node program and this machine has no node.

Install Node >= $NEEDS_NODE — nodejs.org, or a version manager: mise, nvm, volta —
and run this again. npm comes with it, which is all else this needs."

  # Compared by Node itself, against the one number at the top of this file.
  # Shell has no way to compare two dotted versions that is shorter than being
  # wrong about 22.9 and 22.19.
  node --eval '
    const [need, have] = [process.argv[1], process.versions.node].map((v) => v.split(".").map(Number))
    process.exit(have[0] > need[0] || (have[0] === need[0] && have[1] >= (need[1] ?? 0)) ? 0 : 1)
  ' "$NEEDS_NODE" || die "Tade needs Node >= $NEEDS_NODE and this is $(node --version).

Upgrade Node and run this again — nodejs.org, or whichever of mise, nvm or
volta put this one here."

  # Which package manager, where nobody said.
  #
  # npm comes with Node, so on a machine that can run Tade at all it is the one
  # that is certainly there. The other two are chosen only where they are asked
  # for or where npm is missing — not because they are worse, but because an
  # installer that quietly picks a different manager puts the command somewhere
  # the person was not expecting and leaves it to be found later.
  if [ -z "$manager" ]; then
    for one in npm pnpm bun; do
      if have "$one"; then
        manager="$one"
        break
      fi
    done
  fi
  [ -n "$manager" ] || die "Tade installs from npm and this machine has none of npm, pnpm or bun.

npm comes with Node, so the shortest way here is a Node >= $NEEDS_NODE from
nodejs.org or a version manager: mise, nvm, volta."

  spec="$PACKAGE"
  [ -z "$version" ] || spec="$PACKAGE@$version"

  # Deliberately unquoted: `approval_for` returns nought, one or three words
  # and every one of them is this script's own text, from the constants at the
  # top. Nothing a person typed reaches here — the version goes in `$spec`,
  # which is quoted everywhere it is used, and nothing is ever `eval`ed.
  # shellcheck disable=SC2046
  case "$manager" in
    npm) set -- npm install --global $(approval_for npm) "$spec" ;;
    pnpm) set -- pnpm add --global $(approval_for pnpm) "$spec" ;;
    bun) set -- bun add --global $(approval_for bun) "$spec" ;;
  esac

  say "Tade installs from npm: the package \`$PACKAGE\`, which puts the command \`$COMMAND\` on your PATH."
  say "This runs one command with $manager, and nothing else:"
  say ''
  say "  $*"
  say ''

  [ -z "$dry" ] || exit 0
  have "$manager" || die "install: --$manager, and this machine has no $manager."

  "$@"
  report "$manager"
}

# The one line that does anything, and the reason everything above it only
# defines. See rule 4 at the top: a download that was cut off never reaches
# here — including the one failure this URL has in practice, a site that
# answers a page of HTML with a 200 instead of this file.
main "$@"
