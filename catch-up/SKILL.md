---
name: catch-up
description: Start a session (thread) by catching up - read where earlier sessions left off (handoffs in Issues, PR comments, docs, TODO) and the open Issues and PRs, summarize where things stand, and propose the next task. With an Issue number (#N), grasp the Issue and the code and docs it touches, propose a plan, and stop before implementing. With a PR number, summarize where the PR stands and the next step. The counterpart of wrap-up. Use when the user starts a thread and asks to get up to speed, e.g. "全体を把握して次のタスクを提案して", "前回どこまで進めた?", "現状を把握してください", "#12 対応を進めます。Issue 内容とプロジェクト全体を把握してください", "#22 を進めましょう", "まずは Issue 内容と影響範囲を把握してください". Not for work already in progress in this session.
argument-hint: "[#N] [notes, e.g. what to look at]"
---

# Catch up

The user is starting work in this session, and earlier sessions (or teammates) left work and handoffs behind. Read before acting: find out where things stand, summarize it, propose what to do next, and stop. Do not start the work itself.

**Always write in the specified language**: the summary, the plan, and the questions to the user. The language is the one specified in the user's settings or instructions (e.g. the `language` setting, CLAUDE.md, or the project's rules); if none is specified, use the language the user writes in. Do not switch to English just because these instructions are in English.

## Arguments

Arguments given: `$ARGUMENTS`

- **No number**: catch up on the whole project (see "Catch up on the project")
- **An Issue or PR number** (`#N`, `N`, or its URL): catch up on that one (see "Catch up on #N"). A URL may point to another repository (e.g. the upstream of a fork): use the owner and repository in the URL; otherwise use the current repository. GitHub numbers Issues and PRs together, so find out which it is (`gh api repos/<owner>/<repo>/issues/<N>` has a `pull_request` field for a PR)
- **Notes**: any other words are free-form notes from the user (e.g. "影響範囲も見て", "docs は見なくていい"). They can come together with a number (e.g. `#12 影響範囲も見て`): the number picks what to catch up on, and the rest are notes. Notes override the defaults below

If the skill was invoked from a natural-language request and the arguments are empty, read the same information from the user's message (e.g. "#22 対応を進めます" → `#22`).

## Project rules

Read the project's rules first (CLAUDE.md, AGENTS.md, README, `docs/`): the branch flow and naming, where TODOs live, whether `docs/` is the spec. They take precedence over this skill, and the plan must follow them.

## Read only

This skill only reads and proposes. Do not commit, push, create or switch branches, edit files, or post to Issues or PRs. The only change allowed is updating remote-tracking branches with `git fetch --prune`: run it once at the start, before comparing anything with the remote, so that upstreams and remote branches are current. Skip a check if it does not apply (e.g. not a git repository, `gh` not available or not authenticated, no remote), and say so in the summary.

## Catch up on the project

### 1. Read the state

**Repository**
- Current branch, uncommitted changes and untracked files, stashes, worktrees (`git worktree list`), and unpushed commits: compare each local branch with its upstream, and count a branch with no upstream as unpushed. A branch whose upstream is gone after the fetch (`[gone]` in `git branch -vv`) is not unpushed: its remote branch was deleted, usually because its PR was merged. Report it separately as probably merged (check `gh pr list --state merged --head <branch>`). These may be left over from an earlier session: report them, do not touch them
- Recent history of the default branch (e.g. the last 10-20 commits and merges), to see what was done last

**Handoffs** (where wrap-up and teammates leave them)
- Open PRs: what each does, review state, unresolved review threads, CI checks, and the latest comments (a PR comment may describe where the work stands and the next step). Get them for all open PRs in one query (see "Open PRs in one query"), not one PR at a time
- Open Issues: titles and labels of all of them; the body and recent comments of the recently updated ones
- The task list the project keeps (TODO.md or similar), and recent changes to `docs/`

`gh issue list` and `gh pr list` return only 30 items by default, newest created first: pass a `--limit` large enough for all open ones (e.g. `--limit 500`) and `--json number,title,labels,updatedAt`, and sort by `updatedAt` yourself. If the result reaches the limit, say that the list may be cut. If there are many open Issues (more than about 20), read the titles of all and the details of the 10 most recently updated, and say that you did; the same for PRs, counted separately.

**Open PRs in one query**: this gets the open PRs, most recently updated first, with their review state, CI state, latest conversation comments (where handoffs are left), and review threads. For each thread, the last comment is enough here; if a PR has more threads than one page (`reviewThreads.pageInfo.hasNextPage`), get the rest as in "Unresolved review threads". If there are more open PRs than one page (`pullRequests.pageInfo.hasNextPage`), say that the list may be cut; read a PR's older comments with `gh pr view <N> --comments` when the latest ones point to them. If a PR has more comments than were fetched (`comments.totalCount`) and none of the fetched ones is a review result comment, look for the latest one as in "Review result comments".

```sh
gh api graphql -F owner=<owner> -F name=<repo> -f query='
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage }
        nodes {
          number title updatedAt headRefOid author { login } reviewDecision mergeable
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          comments(last: 3) { totalCount nodes { author { login } body createdAt } }
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes { isResolved isOutdated path comments(last: 1) { nodes { author { login } } } }
          }
        }
      }
    }
  }'
```

**Unresolved review threads** (for one PR): the REST list of review comments does not say whether a thread is resolved, and returns 30 per page. Use GraphQL instead, paging through all threads, and count only those with `isResolved: false`:

```sh
gh api graphql --paginate -F owner=<owner> -F name=<repo> -F number=<N> -f query='
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        author { login }
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved isOutdated path line comments(last: 20) { nodes { author { login } body } } }
        }
      }
    }
  }'
```

A thread that is not resolved but whose last comment is from the PR author may already be addressed: say so instead of calling it unanswered. If the reviewer and the author use the same account (e.g. a reviewer session run by the same person), the login cannot tell them apart: judge from what the comments say, and say that you did.

**Review result comments**: a reviewer session may post its result as a PR comment after every review: you-are-a-reviewer with `--comment` posts whether it is LGTM, the number of findings or how many of the previous findings were resolved, and the full SHA of the head commit it reviewed. Such a comment starts with the line `<!-- you-are-a-reviewer:result -->`; count only comments with this marker, not comments that merely mention LGTM (the author may use the same account). To find the latest one among all the comments of a PR, take the last line printed by:

```sh
gh api repos/<owner>/<repo>/issues/<N>/comments --paginate \
  --jq '.[] | select(.body | startswith("<!-- you-are-a-reviewer:result -->")) | {created_at, body}'
```

Read the latest one as where that reviewer session's review stands:

- LGTM: the review by that session has passed
- Not LGTM: the points it says are still open are the next thing to address

Then compare its SHA with the PR's current head commit (`headRefOid`), whether it is LGTM or not. If they match, the result is for the current head: with LGTM and nothing else open, the PR is waiting for the user's decision to merge. If they differ, say which commits were pushed after it: they have not been reviewed, so the next step may be to request a (re-)review rather than to fix the open points again.

The comment covers only that reviewer session's review. Report it together with the rest of the review state, not instead of it: a human reviewer's `reviewDecision` (e.g. `CHANGES_REQUESTED`), and review threads opened or left unresolved by others, still stand.

### 2. Summarize and propose

- **Where things stand**: what was done recently, what is in progress (open PRs, branches, leftovers in the working tree), and what is waiting on someone (e.g. a PR waiting for review, an Issue waiting for a decision)
- **Candidates for the next task**: a few, each with why it matters now. Recommend one and say why (e.g. finishing an open PR before starting a new Issue, a task that unblocks others, a quick fix)

Then ask which one to take (AskUserQuestion, with the recommended one first). If the user picks one, catch up on it:

- An Issue or a PR: as in "Catch up on #N"
- Something else (leftover changes in the working tree, a local branch with no PR, an item in TODO.md, etc.): read what it is (the diff, the branch's commits against the default branch, the TODO item and what it refers to) and the code and docs it touches, then propose a plan with the same parts as for an Issue, and stop

## Catch up on #N

First, read whether it is open. If it is closed or merged, say so, point to what remains (e.g. follow-up Issues, or a PR that closed it), and stop there instead of making a plan.

### An Issue

1. **Read the Issue**: the body, all comments, labels, and linked or referencing PRs and Issues. Check whether work on it has already started: a PR that refers to it, or a branch named after it, local or remote (`git branch -a`), including one checked out in another worktree (`git worktree list`)
2. **Read the project**: the rules, the docs that act as the spec, the structure, and then the code, tests, and docs the Issue touches. Find the impact: the files that would change, the tests to add or update, and the docs that must change with the code
3. **Find what is open**: unclear or contradictory points in the Issue, and the decisions it leaves open (the Issue may list them)
4. **Propose a plan**:
   - **The Issue**: the problem and the expected behavior, in a few lines
   - **Now**: how the relevant code behaves today, with `file:line` references
   - **Impact**: the files, tests, and docs that would change
   - **Plan**: the steps, in units that can each be committed
   - **Branch**: a name that follows the project's naming rule. Do not create it; it is created once the plan is approved
   - **Decisions**: the direction-level decisions the user should make (ask them with AskUserQuestion), and the details you will decide yourself (list them so that the user can object). Give each decision a short name (e.g. **Name of the mod**, **How to notify**), not a number

### A PR

1. **Read the PR**: the description, state, base and head, commits, review decisions, review comments and the unresolved review threads (see "Unresolved review threads"), the latest review result comment (see "Review result comments"), CI checks, merge conflicts, and the Issue it closes
2. **Read the local state**: whether the head branch exists locally, whether it is checked out, and whether it is in sync with the remote
3. **Summarize**: what the PR does, where it stands (approved, LGTM from a reviewer session and for which commit, changes requested, unresolved comments, failing checks, conflicts), what the latest handoff comment says, and the next step (e.g. address the unresolved comments, request a re-review). Merging is the user's decision; do not propose to merge on your own

Then stop. Do not start implementing, even if the plan looks obvious. Wait for the user's go-ahead.

## Writing the summary

- Lead with the conclusion (what to do next), then the details
- Use headings and short labeled bullets. Name things instead of numbering them, so that the user does not have to match numbers to items. This applies to candidates, decisions, and options alike: refer to them by a short name (e.g. **Name of the mod**), never as "option 2" or "the 4 points". Number only steps whose order matters
- Reference code as `file:line`, and Issues and PRs as `#N`
- Keep what you read apart from what you infer, and say what you could not check

## Notes

- This skill is read only (see "Read only"). Branches, commits, and comments come after the user approves the plan
- Write the summary, plan, and questions in the specified language (see the top)
