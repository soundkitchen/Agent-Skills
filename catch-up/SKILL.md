---
name: catch-up
description: Start a session (thread) by catching up - read where earlier sessions left off (handoffs in Issues, PR comments, docs, TODO) and the open Issues and PRs, summarize where things stand, and propose the next task. With an Issue or PR number (#N), grasp that Issue or PR and the code and docs it touches, propose a plan, and stop before implementing. The counterpart of wrap-up. Use when the user starts a thread and asks to get up to speed, e.g. "全体を把握して次のタスクを提案して", "前回どこまで進めた?", "現状を把握してください", "#12 対応を進めます。Issue 内容とプロジェクト全体を把握してください", "#22 を進めましょう", "まずは Issue 内容と影響範囲を把握してください". Not for work already in progress in this session.
argument-hint: "[#N] [notes, e.g. what to look at]"
---

# Catch up

The user is starting work in this session, and earlier sessions (or teammates) left work and handoffs behind. Read before acting: find out where things stand, summarize it, propose what to do next, and stop. Do not start the work itself.

**Always write in the specified language**: the summary, the plan, and the questions to the user. The language is the one specified in the user's settings or instructions (e.g. the `language` setting, CLAUDE.md, or the project's rules); if none is specified, use the language the user writes in. Do not switch to English just because these instructions are in English.

## Arguments

Arguments given: `$ARGUMENTS`

- **Empty**: catch up on the whole project (see "Catch up on the project")
- **An Issue or PR number** (`#N`, `N`, or its URL): catch up on that one (see "Catch up on #N"). GitHub numbers Issues and PRs together, so find out which it is (`gh api repos/{owner}/{repo}/issues/<N>` has a `pull_request` field for a PR)
- **Anything else**: free-form notes from the user (e.g. "影響範囲も見て", "docs は見なくていい"). They override the defaults below

If the skill was invoked from a natural-language request and the arguments are empty, read the same information from the user's message (e.g. "#22 対応を進めます" → `#22`).

## Project rules

Read the project's rules first (CLAUDE.md, AGENTS.md, README, `docs/`): the branch flow and naming, where TODOs live, whether `docs/` is the spec. They take precedence over this skill, and the plan must follow them.

## Read only

This skill only reads and proposes. Do not commit, push, create or switch branches, edit files, or post to Issues or PRs. The only change allowed is updating remote-tracking branches with `git fetch --prune`. Skip a check if it does not apply (e.g. not a git repository, `gh` not available or not authenticated, no remote), and say so in the summary.

## Catch up on the project

### 1. Read the state

**Repository**
- Current branch, uncommitted changes and untracked files, stashes, unpushed commits (compare each local branch with its upstream; a branch with no upstream counts as unpushed), worktrees (`git worktree list`). These may be left over from an earlier session: report them, do not touch them
- Recent history of the default branch (e.g. the last 10-20 commits and merges), to see what was done last

**Handoffs** (where wrap-up and teammates leave them)
- Open PRs: what each does, review state, unresolved review threads (see "Unresolved review threads"), CI checks (`gh pr checks`), and the latest comments (a PR comment may describe where the work stands and the next step)
- Open Issues: titles and labels of all of them; the body and recent comments of the recently updated ones
- The task list the project keeps (TODO.md or similar), and recent changes to `docs/`

`gh issue list` and `gh pr list` return only 30 items by default: pass a `--limit` large enough for all open ones (e.g. `--limit 500`), and if the result reaches the limit, say that the list may be cut. If there are many open Issues or PRs (more than about 20), read the titles of all and the details of the 10 most recently updated, and say that you did.

**Unresolved review threads**: the REST list of review comments does not say whether a thread is resolved, and returns 30 per page. Use GraphQL instead, paging through all threads, and count only those with `isResolved: false`:

```sh
gh api graphql --paginate -F owner=<owner> -F name=<repo> -F number=<N> -f query='
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved isOutdated path line comments(first: 20) { nodes { author { login } body } } }
        }
      }
    }
  }'
```

A thread that is not resolved but has a reply from the PR author may already be addressed: say so instead of calling it unanswered.

### 2. Summarize and propose

- **Where things stand**: what was done recently, what is in progress (open PRs, branches, leftovers in the working tree), and what is waiting on someone (e.g. a PR waiting for review, an Issue waiting for a decision)
- **Candidates for the next task**: a few, each with why it matters now. Recommend one and say why (e.g. finishing an open PR before starting a new Issue, a task that unblocks others, a quick fix)

Then ask which one to take (AskUserQuestion, with the recommended one first). If the user picks one, catch up on it:

- An Issue or a PR: as in "Catch up on #N"
- Something else (leftover changes in the working tree, a local branch with no PR, an item in TODO.md, etc.): read what it is (the diff, the branch's commits against the default branch, the TODO item and what it refers to) and the code and docs it touches, then propose a plan with the same parts as for an Issue, and stop

## Catch up on #N

### An Issue

1. **Read the Issue**: the body, all comments, labels, and linked or referencing PRs and Issues. Check whether work on it has already started: a PR that refers to it, or a branch named after it, local or remote (`git branch -a` after `git fetch --prune`), including one checked out in another worktree (`git worktree list`)
2. **Read the project**: the rules, the docs that act as the spec, the structure, and then the code, tests, and docs the Issue touches. Find the impact: the files that would change, the tests to add or update, and the docs that must change with the code
3. **Find what is open**: unclear or contradictory points in the Issue, and the decisions it leaves open (the Issue may list them)
4. **Propose a plan**:
   - **The Issue**: the problem and the expected behavior, in a few lines
   - **Now**: how the relevant code behaves today, with `file:line` references
   - **Impact**: the files, tests, and docs that would change
   - **Plan**: the steps, in units that can each be committed
   - **Branch**: a name that follows the project's naming rule. Do not create it; it is created once the plan is approved
   - **Decisions**: the direction-level decisions the user should make (ask them with AskUserQuestion), and the details you will decide yourself (list them so that the user can object)

### A PR

1. **Read the PR**: the description, state, base and head, commits, review decisions, review comments and the unresolved review threads (see "Unresolved review threads"), CI checks, merge conflicts, and the Issue it closes
2. **Read the local state**: whether the head branch exists locally, whether it is checked out, and whether it is in sync with the remote
3. **Summarize**: what the PR does, where it stands (approved, changes requested, unresolved comments, failing checks, conflicts), what the latest handoff comment says, and the next step (e.g. address the unresolved comments, request a re-review). Merging is the user's decision; do not propose to merge on your own

If the Issue or PR is closed or merged, say so, and point to what remains (e.g. follow-up Issues).

Then stop. Do not start implementing, even if the plan looks obvious. Wait for the user's go-ahead.

## Writing the summary

- Lead with the conclusion (what to do next), then the details
- Use headings and short labeled bullets. Name things instead of numbering them, so that the user does not have to match numbers to items (e.g. refer to a candidate by a short name, not "option 2")
- Reference code as `file:line`, and Issues and PRs as `#N`
- Keep what you read apart from what you infer, and say what you could not check

## Notes

- This skill is read only (see "Read only"). Branches, commits, and comments come after the user approves the plan
- Write the summary, plan, and questions in the specified language (see the top)
