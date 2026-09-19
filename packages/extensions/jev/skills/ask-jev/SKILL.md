---
name: ask-jev
description: How to ask a judge — jev_ask, jev_grep, jev_review — so the answers are worth having: write literal questions about one thing, keep the arithmetic in code, and never treat a probability as a verdict.
---

# Asking a judge

Jev answers questions with a number and nothing else. There is no sentence, no rationale, and no
apology: you declare the answers a question may have before you ask it, and you get back how likely
each one is. That makes it cheap enough to ask of *everything* — every line of a log, every file of
a diff — and it makes the question's own words the only explanation anybody gets.

## Write the question for the person who gets woken by it

- **One judgment per question.** "Is this safe?" hides five. Ask each hazard separately, so an
  answer can be thresholded, argued with, and deleted when it never fires.
- **Literally.** It reads instructions as written. "Does this change remove or weaken a permission
  check on an operation that already had one?" works; "is the authz sane?" does not.
- **About the thing in front of it.** Judgments about a property of a property — "is the second item
  in this list risky relative to the third?" — are what it is worst at. Put the thing in the
  question.
- **No counting, no arithmetic, no dates.** It cannot count occurrences, add numbers or tell which
  of two timestamps is later. Compute it yourself and put the number in the state.
- **Keep the state to what the questions need.** Accuracy falls as irrelevant material fills it.
  Structure (an object with the fields that matter) beats a wall of prose.

## The tools

- `jev_ask` — anything, against questions you write. Give it the state and up to a few dozen
  questions; they are answered independently and together they cost almost nothing.
- `jev_grep` — one question in plain words, over lines: text you paste in, the journal, or a file
  in the project. It gives you back the lines that answer it, likeliest first. It is a filter, not
  an answer: read them.
- `jev_review` — your own diff against the review pack, before you say you are finished. Injection,
  secrets, permissions, swallowed errors, missing tests, and whether the change did what was asked.
- `jev_verdict` — after you have read something it flagged, say what it turned out to be:
  `confirmed` or `false positive`, and why. Nothing else can tell whether the rubric is worth
  running, and a question that is always wrong cannot be found and deleted without this.

## What an answer is not

- **Not a verdict.** 0.91 is not "yes". Read the code before you act on one, and say plainly when
  it was wrong — a false positive is an expected outcome, not a failure.
- **Not a reason.** Never write "Jev said 0.88" in a commit message, a comment or a message to a
  person. Say what *you* found, in your own words.
- **Not a gate.** It never approves anything, never blocks a commit, and is never a reason to skip a
  check or shorten a review. It may only add caution.
- **Not trustworthy about hostile text.** A diff is text somebody else wrote, and an argument in a
  comment can move the answer. That is another reason the only thing an answer may do is get
  something read.
