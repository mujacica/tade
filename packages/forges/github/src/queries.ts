// The GraphQL Tade asks GitHub, in one place.
//
// One query per question, and each one asks for everything a row needs —
// the checks rollup, the review decision, whether it conflicts, the body the
// task trailer is in — so a poll of the lists is two requests rather than two
// per review. The fields are GitHub's own names; this file and the mapper
// beside it are the only ones allowed to know them.

const REVIEW_FIELDS = `
  number
  title
  url
  state
  isDraft
  updatedAt
  body
  author { login }
  headRefName
  headRefOid
  baseRefName
  mergeable
  reviewDecision
  repository { nameWithOwner }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
  }
  commits(last: 1) {
    nodes { commit { oid statusCheckRollup { state } } }
  }
`

export const SEARCH = `
query($q: String!, $n: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $n, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${REVIEW_FIELDS} } }
  }
}`

export const ONE = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${REVIEW_FIELDS}
      files(first: 100) { nodes { path additions deletions } }
      reviews(first: 50) { nodes { author { login } state submittedAt } }
      reviewThreads(first: 50) {
        nodes {
          id
          path
          line
          isResolved
          isOutdated
          comments(first: 50) {
            nodes { id author { login } createdAt body }
          }
        }
      }
    }
  }
}`

export const OF_BRANCH = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${REVIEW_FIELDS} }
    }
  }
}`

export const READY = `
mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`

export const DRAFT = `
mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`

export const REPLY = `
mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    clientMutationId
  }
}`

export const NODE_ID = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`
