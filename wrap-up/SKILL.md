---
name: wrap-up
description: Wrap up the current session (thread) before the user closes it - find loose ends (uncommitted or unpushed work, stale docs, servers left running, merged branches and worktrees), clean up the mechanical ones, and hand off what remains to where it belongs (Issues, PR comments, docs, TODO). Use when the user is about to end the thread, e.g. "ここで区切りましょう", "このスレッドはここまでにしよう", "閉じる前にやっておくべきことはありますか？", "やり残した作業はありますか？", "別スレッドに移る前に片付けて". Not for ending a single task in the middle of a thread.
argument-hint: "[notes, e.g. what to keep running]"
---

# Wrap up the session

The user is about to close this session and continue in another one. Make sure nothing is left behind: clean up what is mechanical, ask about what needs judgment, and leave the remaining work where the next session (or a teammate) will find it.

## Arguments

Arguments given: `$ARGUMENTS`

Free-form notes from the user (e.g. "dev サーバーは残して", "docs は見なくていい"). They override the defaults below. If the skill was invoked from a natural-language request, read such notes from the user's message too.

## Project rules

Follow the project's rules (CLAUDE.md, AGENTS.md, docs): branch flow, commit message language, keeping docs in sync with code, where TODOs live, which language Issues and comments are written in. They take precedence over this skill.

## 1. Collect loose ends

Look at both the repository and this conversation. Do not change anything in this step, except updating remote-tracking branches with `git fetch --prune`. Skip a check if it does not apply (e.g. not a git repository, `gh` not available or not authenticated, no remote).

**Repository**
- Current branch, uncommitted changes and untracked files (`git status --porcelain`), stashes
- Unpushed commits (compare with the upstream; a branch with no upstream counts as unpushed)
- `git fetch --prune`, then: merged local branches, and worktrees (`git worktree list`) whose branch is merged (see "Merged branches" below)
- The current branch's PR and its state (`gh pr view`); other open PRs and Issues this session worked on

**Merged branches**: a branch counts as merged only if its PR was merged (`gh pr list --state merged --head <branch>`), or its upstream is gone after `git fetch --prune`. Do not use `git branch --merged` alone: a branch just created from the default branch, with no commits yet, also appears there, and it may be another session's work that has just started. A branch that points at the same commit as the default branch (`origin/<default>`) and has no merged PR is not merged; report it instead.

**This session**
- Background processes this session started (dev servers, watchers, background shells, `Monitor`s) that are still running
- Temporary files this session created outside ignored directories (e.g. screenshots or scratch files in the repo root)
- Docs that no longer match what was implemented or decided in this session (README, `docs/`, CLAUDE.md, TODO.md, etc.). Compare the changes of this session (the branch's diff and uncommitted changes) against them
- What remains of the work: unfinished tasks, follow-ups the user postponed (e.g. "別 Issue にしよう", "あとで"), bugs found but not fixed, open questions, and decisions or findings that exist only in this conversation

Only consider things this session created or worked on, plus merged branches and worktrees. Do not touch processes, files, or branches the user created or that belong to other sessions; if something looks abandoned but you are not sure, report it instead.

## 2. Clean up the mechanical ones (no confirmation)

Do these without asking, unless the user's notes say otherwise, in this order:

1. Stop the background processes this session started
2. If the current branch is merged, the working tree is clean, and you are in the main worktree, switch to the default branch and update it (`git pull --ff-only`). Doing this first lets the branch deletions below succeed with `-d`
3. Remove worktrees whose branch is merged and that have no uncommitted changes (`git worktree remove`, never `--force`). Never remove the main worktree or the worktree this session is working in (`git worktree remove` succeeds even when run from inside the worktree it removes); report those instead
4. Delete merged local branches (`git branch -d`, never `-D`). Never delete the current branch, the default branch, a branch still checked out in a worktree, or remote branches

If any of these fails or looks unsafe (e.g. unmerged commits, uncommitted changes), stop that item and report it instead.

## 3. Propose the rest and ask

Show the user one list of everything else, each item with what you propose to do. Then ask which ones to do (AskUserQuestion with multiSelect, or a plain question if the list is long). Typical items:

- **Uncommitted changes**: commit them (on a topic branch if the project's flow requires one), or leave them
- **Unpushed commits**: push them
- **Stale docs**: update them (commit them together with the change they describe, if the project requires that)
- **Temporary files**: delete them, or keep them
- **Remaining work and knowledge**: hand each piece off to the place it belongs (draft the content, so that the user can judge it):
  - A task, follow-up, or bug → a new Issue, or a comment on the existing Issue it belongs to
  - The state of an open PR (what is done, what is left, what the next step is) → a comment on that PR
  - A specification, design decision, or how-to → the matching file in `docs/` (or README, or CLAUDE.md for rules for agents)
  - A task list the project keeps in TODO.md (or similar) → that file
  - When unsure where something belongs, propose a place and say why

Do not create a separate handoff file unless the project already has such a convention. Put each piece where people already look for it.

If there is nothing to propose, say so and skip to step 5.

## 4. Do what the user approved

Do only the approved items, following the project's rules. Do not do anything else, and do not push, open PRs, or merge unless that was part of what was approved.

## 5. Report

Report briefly:

- What was cleaned up automatically in step 2
- What was done in step 4, with links (Issues, PR comments, commits)
- What was left as is, and anything you could not check
- Where the next session should start (e.g. "次は #12 から。続きは PR #34 のコメント参照"), pointing to where the handoff was written

Do not end the session yourself. The user closes it.

## Notes

- Write the report and questions in the language the user uses
- Creating Issues, posting comments, committing, and pushing are outward-facing or hard to undo: do them only when approved in step 3
