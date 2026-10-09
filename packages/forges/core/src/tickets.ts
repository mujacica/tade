import type { Page } from './port.ts'

// Tickets: the things people *file* on a forge, as against the branches they
// offer for merge.
//
// Its own file because it is a port within the port — its own objects, its own
// query, its own capability and its own conformance section — and because
// `port.ts` is about work that is ready for somebody to look at and this is
// about work nobody has started. The arrow is types only, both ways, so
// nothing is imported at runtime and nothing is evaluated in either order.
// `watch.ts` in `extensions/core` makes the same split for the same reason.
//
// **Vocabulary rule (R2).** GitHub, GitLab and Jira all say "issue" and all
// three mean something slightly different by it, and GitHub means a pull
// request by it as well — its own documentation says "GitHub's REST API
// considers every pull request an issue, but not every issue is a pull
// request". So the object here is a `Ticket`: Tade's own word for a filed
// request, and the one thing a `Ticket` can never be is a `Review`.
//
// **It is one capability and it is optional.** `capabilities.tickets` is
// declared, never sniffed (R3); a forge that says false throws `unsupported`
// from both methods and nothing calls them. Mailing patches to a list is a
// forge with reviews and no tickets, which is the case this shape exists to
// let through rather than to pretend about.

/** Where a ticket lives, and how to ask about it again. Never a `ReviewRef`. */
export interface TicketRef {
  /** The repository as the forge names it: `owner/name`. */
  repo: string
  /** Its number there. */
  number: number
  /** The host it is on, so two forges never collide: `github.com`. */
  host: string
}

/**
 * Somebody who did something, as the forge names them.
 *
 * `bot` is **the forge's own word** about the actor and never a reading of the
 * login's text: a convention like a `[bot]` suffix is a convention, and the
 * day somebody registers an account that ends in it the reading is wrong in
 * the direction that matters. An implementation that can only see the
 * convention says so where it maps it.
 */
export interface Actor {
  login: string
  bot: boolean
}

/**
 * That a label is on a ticket, and **who put it there**.
 *
 * The whole reason this is its own answer: a ticket's label list says what is
 * on it now and says nothing about whose act that was, and the act of
 * labelling is the thing a caller may want to authorise. An author who cannot
 * label and a labeller who did not write a word of it are two different people
 * in the ordinary case, so a caller that read the author as the labeller would
 * authorise the wrong one.
 */
export interface Labelling {
  label: string
  by: Actor
  /** When it was applied, as the forge says it. */
  at: string
}

/** A filed request, as any forge can describe one. */
export interface Ticket {
  ref: TicketRef
  title: string
  /** As written. Never summarised and never trimmed: it is what somebody asked for. */
  body: string
  url: string
  /** Neutral and lowercase; a forge's own spelling of either stays in the forge. */
  state: 'open' | 'closed'
  /** Whose it is — who wrote the words. Never read as authority by anybody. */
  author: Actor
  /** The labels on it **now**. What is on it is not who put it there. */
  labels: readonly string[]
  /** Who it is assigned to, as the forge names them. */
  assignees: readonly string[]
  createdAt: string
  /**
   * When the forge last says it moved. Whether a comment moves it is the
   * forge's own answer and not this port's to normalise — GitHub's does — so a
   * caller comparing revisions must expect it to move for more than an edit.
   */
  updatedAt: string
}

export interface TicketDetail extends Ticket {
  /**
   * Who applied each label that is on it now, newest application first.
   *
   * **A label with nothing here is a label nobody could be named for**, which
   * is a first-class answer and never the same as one applied by somebody
   * unknown: a forge that keeps no history of labelling says so by handing
   * back an empty list, and a caller that needs the actor must refuse rather
   * than assume one. Never the author as a stand-in.
   */
  labelled: readonly Labelling[]
}

/** What to list. One repository at a time: a ticket query is not a search. */
export interface TicketQuery {
  /** `owner/name`. Required: nothing here lists the world. */
  repo: string
  /**
   * Every one of these labels must be on it. Empty is every ticket, which is
   * a caller's decision to make and never a default this port supplies.
   */
  labels?: readonly string[]
  state?: 'open' | 'closed' | 'any'
  /** Only what the forge says moved at or after this moment. */
  since?: string
  /** At most this many. A forge never pages on its own. */
  limit?: number
  cursor?: string | null
  /**
   * What the last identical ask came back with, to be asked again cheaply.
   *
   * Opaque: a validator the forge handed over and the caller kept, carried
   * back unread. On GitHub it is an `etag` and an unchanged answer is a `304`
   * that, in GitHub's own words, "does not count against your primary rate
   * limit" — which is what makes polling a repository every ten minutes cost
   * almost nothing. A forge with no such thing ignores it and never says
   * `unchanged`.
   */
  validator?: string | null
}

/**
 * A page of tickets, **newest movement first**, and what makes the same ask
 * cheap next time.
 *
 * The order is part of the contract because a caller that reads only the head
 * of a page — anything with a budget — is reading it to find what just
 * happened. Answered oldest-first, or in whatever order the forge keeps them,
 * the one thing such a caller would never see is the thing somebody did a
 * minute ago, which is the thing it was looking for.
 */
export interface TicketPage extends Page<Ticket> {
  /**
   * Nothing has changed since the `validator` that was handed in, so `items`
   * is empty because there was nothing to read — **not because there is
   * nothing there**. A caller that read those two as one would forget
   * everything it had found the first time the answer stayed the same.
   */
  unchanged: boolean
  /** To hand back as `validator` next time; null where the forge offers none. */
  validator: string | null
}
