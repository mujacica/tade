---
name: cut-a-release
description: Publish Tade to npm as `tade-sh` — the changelog, the version, the tag, and the workflow that does the rest. Use when somebody asks for a release, a version bump or a publish, and read it before changing anything under `scripts/release/`.
---

# Cutting a release

Tade goes out as **one** npm package, `tade-sh`, installing the command `tade`. Everything under
`packages/` ships inside it and nothing else is published. `AGENTS.md` says why, under *One package
goes out*; this is how to do it.

## The three commands

```sh
pnpm release 0.2.0 --dry-run          # rehearse; writes nothing outside dist/
pnpm release 0.2.0                    # CHANGELOG.md, the version, a commit, a tag — all local
git push origin main --follow-tags    # the tag is what publishes
```

**The third one is a person's.** Do the first two, say what they produced, and ask — unless whoever
asked for the release already said to push it. Everything up to the tag is undoable in ten seconds;
the push starts a workflow that puts a version on npm, and **a version on npm cannot be taken back
or reused**. This is the same rule as `merge`: the machine prepares, a person lets it out.

## Choosing the version

Plain semver. `package.json` says where it is now, `git tag --list 'v*'` says what has gone out. A
prerelease (`0.2.0-rc.1`) is accepted everywhere a version is. If which number it should be is not
obvious from what changed, ask — that is a decision, not a lookup.

## The dry run is not optional

It is the only thing that proves the package works, and it is the whole release minus four writes:

- the changelog and the release notes, in `dist/`
- the staged publish directory and the tarball, `dist/tade-sh-<version>.tgz`
- **then it installs that tarball into a directory of its own and runs the `tade` inside it** —
  `--version`, `--help`, `status --json`

That last part is the point. `pnpm check` runs against this checkout, where every `@tade/…`
specifier resolves through pnpm's workspace links; it says nothing at all about whether a package a
stranger installs can find its own files. Answering `--version` at all means every one of the
packages resolved through the generated `exports` map, because the CLI builds its whole command tree
at load.

`--no-smoke` skips the install. Use it only when the network is the problem, and say that you did.

## Reading a refusal

Staging checks itself and throws a list rather than shipping. What each one means:

| it says | it means |
| --- | --- |
| `… is TypeScript` | a file escaped the strip pass — the tarball cannot contain `.ts` |
| `… is a second package.json` | it would become the closest package scope and `tade-sh/core` would stop resolving |
| `exports ./x points at …, which is not there` | a package's own `exports` names a file that does not exist |
| `… names ./y.js, which is not there` | usually a new file that **git does not track yet** — `git add` it |
| `… imports tade-sh/z, which no exports key answers` | a new subpath import with no `exports` entry behind it; add it to that package's own `exports` |
| `… is imported by a file that ships and no package depends on it` | declare it in the dependencies of the package that imports it |
| `… is declared as ^1 and ^2` | one published package can hold one range; make the workspace agree first |

`pnpm release` also refuses before it starts: not on `main`, uncommitted changes, behind
`origin/main`, or a tag that already exists. Each is said in full. The uncommitted-changes one
matters most here — agents share this checkout, and a release must carry the changelog and the
version and nobody else's work.

## What the workflow does with the tag

`.github/workflows/release.yml`, in order, and each waits for the one before it:

1. **gate** — calls `.github/workflows/ci.yml`, which is `pnpm check` on ubuntu and macOS with the
   suite alone on the machine. Not a copy of the gate: the same file every pull request gets.
2. **pack** — checks the tag against `package.json`, writes the notes, stages and packs.
3. **smoke** — installs the tarball on both systems and runs the `tade` inside it.
4. **publish** — `npm publish --provenance` over OIDC, then the GitHub release with the notes and
   the tarball on it.

Run the same workflow from the Actions tab with a version instead, and it rehearses: the same gate,
the same tarball, uploaded as artifacts and **published nowhere**.

## When it goes wrong

- **Red gate, or a failed smoke.** Nothing was published — publish is the last job. Fix it, then
  `git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`, and go again.
- **Published, and it should not have been.** There is no way back. `npm deprecate tade-sh@X.Y.Z
  "…"` says so on the page, and the fix is the next version, not this one.
- **A release that was never pushed.** `git tag -d vX.Y.Z`, then `git reset --soft HEAD~1` puts
  `CHANGELOG.md` and `package.json` back in the index for you. `--soft` touches no file on disk,
  which is what makes it safe in a checkout other agents are working in — `--hard` there would throw
  away somebody's afternoon.

## Before the first release, once

A person's, at a keyboard, and not something an agent can or should do. Say it to them:

- **npm** — npmjs.com/package/tade-sh → Settings → Trusted publisher → GitHub Actions, with the
  organization or user, the repository, workflow filename `release.yml`, and the environment left
  blank.
- **GitHub** — nothing. The workflow declares its own `permissions` and reads no secret.

**Never add an npm token.** Trusted publishing hands the workflow a token good for one publish of
one package from one workflow; a token in a repository is a credential that outlives every reason it
was added. `test/release.test.ts` fails if a `secrets.` reference appears in that workflow at all.

## Things not to do

- **Do not hand-edit `CHANGELOG.md`.** It is generated from the commit subjects, verbatim, by
  `pnpm changelog`. This repository writes subjects as sentences and explains the reasoning in the
  body; nothing reshapes them into `feat:` and `fix:`, and nothing invents a prefix. If a line reads
  badly, the commit read badly.
- **Do not add a build step.** The types come off at publish, with Node's own `stripTypeScriptTypes`,
  because Node refuses to strip types under a `node_modules` path and `npm i -g` puts the package
  under one. `pnpm tade` still runs the `.ts` and always will.
- **Do not publish from a laptop.** `npm publish` by hand has no gate behind it, no provenance and
  no record. The tag is the way.
- **Do not put a release commit in the changelog.** `pnpm release` writes `Release X.Y.Z` and the
  generator drops exactly that subject. Word it any other way and it lists itself.

## If you change any of this

`test/release.test.ts` holds the parts that would otherwise break quietly: what the published
manifest says, that the exports map answers every `@tade/…` specifier this repository actually
writes, what the two rewrite rules do and do not touch, and the handful of facts about the workflow
— that its gate calls `ci.yml`, that `ci.yml` still offers `workflow_call`, that a push to main is
not a trigger, that no `run:` block carries a `${{ }}` expression, and that every script it names
exists. Run `pnpm check`, and then the dry run, which is the only one that proves the thing itself.
