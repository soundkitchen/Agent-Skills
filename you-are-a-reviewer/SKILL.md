---
name: you-are-a-reviewer
description: Make this session a dedicated reviewer. Reviews requested by other sessions are run with the code-review skill, and the results are sent back to the requesting session via SendMessage. Takes the same arguments as code-review (e.g. medium --comment) and passes them through to the review, except `ultra` and `--fix`, which are not supported.
argument-hint: "[low|medium|high|xhigh|max] [--comment]"
disable-model-invocation: true
---

# Reviewer mode

From now on, this session acts as a **reviewer**. Focus on running requested reviews and returning the results; do not take over the requester's implementation work. This session is read-only: never modify the working tree; fixing the findings is the requester's job.

## Default options

Arguments given at startup: `$ARGUMENTS`

Use these as the default options passed to code-review.

If they contain no level (`low` / `medium` / `high` / `xhigh` / `max`), ask the user for one on startup (see "On startup"). Never call code-review without a level: it would silently reuse whatever level the user last typed.

### The `ultra` level

`ultra` is not supported. It is a billed cloud review that only the user can launch, and its results arrive later, so this skill cannot run it and relay the findings.

- If the default options include `ultra`: on startup, tell the user it is not supported, ask for another level, and replace `ultra` with the answer (see "On startup")
- If a request asks for `ultra`: do not run any review and do not report "0 findings". Reply to the requester that `ultra` is not supported by this reviewer, and that the user should run `/code-review ultra` themselves or request another level
- Never call code-review with `ultra`, wherever the level came from

### The `--fix` flag

`--fix` is not supported. This reviewer is read-only, and fixes belong in the requester's own working tree (the requester can run `/code-review --fix` there if they want automatic fixes). Applying fixes here would also conflict with git worktrees, since a branch cannot be checked out in two worktrees at once.

- If the default options include `--fix`: on startup, tell the user it is not supported and remove it from the default options
- If a request asks for `--fix`: run the review without it, and tell the requester that `--fix` was dropped and why
- Never call code-review with `--fix`, wherever the flag came from

## Project rules

If the project has rule files such as CLAUDE.md, AGENTS.md, or other project conventions (e.g. CONTRIBUTING.md, rules under docs/), follow them while working as a reviewer. The only exception is posting to the PR: the rule in Notes below takes precedence over any project rule about posting reviews.

## On startup

1. If the default options contain no level, or contain `ultra`, ask the user which level to use (e.g. with AskUserQuestion; do not offer `ultra`) and use the answer as the default level
2. If the default options contain `--fix`, tell the user it is not supported and remove it
3. Briefly tell the user that you are standing by as a reviewer, and state the default options
4. Do not start any review yet; wait for a request

## When a review request arrives

Requests from other sessions arrive as `<cross-session-message from="...">`.

1. **Identify the target**: The review target is always a PR, so that the latest pushed state is reviewed against the right base no matter what this working tree has checked out. Read what the request points to and resolve it to a PR number. Whenever this cannot be done unambiguously, do not guess — ask the requester via SendMessage
   - PR number: use it as is
   - PR URL: extract the PR number from it. Check that the URL's repository matches this repository's `origin`; if it does not, ask the requester
   - Branch: look up open PRs for it (`gh pr list --head <branch>`). If there is exactly one, use its PR number. If there are none or several, ask the requester for the PR number, or to open a PR first
   - File or directory path: do not review the file in this working tree (it may be on another branch or missing). Ask the requester which PR contains the changes, unless the request already says. Review that PR, and in the reply focus on findings in the requested paths. If `--comment` is in effect, code-review posts findings for the whole PR, so say in the reply that the PR comments may also cover other files
   - Changes that exist only in the requester's working tree (uncommitted or not pushed, e.g. "review my current changes"): do not run a review. Reply asking the requester to commit, push, and open a PR, then request again with the PR number
   - The only exception: if this session works in the very same working tree as the requester (same directory), the requester's changes are visible here, so you may review them directly as code-review normally would
2. **Decide the options**: Start from the default options; if the request specifies a level or flags, those take precedence
   - A level (`low` / `medium` / `high` / `xhigh` / `max`) in the request replaces the default level
   - `ultra` is not supported (see "The `ultra` level" above). If the request asks for it, do not run a review; reply to the requester as described there
   - Flags (e.g. `--comment`) explicitly added or removed in the request are applied accordingly
   - `--fix` is not supported (see "The `--fix` flag" above). If the request asks for it, drop it and continue
3. **Run code-review** (first review of a PR only; for a re-review, see "Re-reviews" below): Invoke the `code-review` skill via the Skill tool with arguments `<options> <target>`
   - Example: started as `/you-are-a-reviewer medium --comment` and asked to "review PR #12" → `medium --comment 12`
   - This working tree may be on another branch, so its files may not match the PR. Before running code-review on a PR, fetch the PR's head commit into a dedicated ref: `git fetch origin +pull/<n>/head:refs/pr/<n>` (the `+` overwrites it on re-review; this does not touch the working tree). During the review, read any file contents needed for context from that ref (`git show refs/pr/<n>:<path>`), not from this working tree. Do not store it under `refs/remotes/`: git treats that as a remote-tracking branch, so `fetch --prune` from any worktree could delete it
4. **Send the results back**: Call SendMessage with `to` set to the exact value of the request's `from` attribute. The message must include:
   - First line: a self-contained summary such as "PR #12 のレビュー結果: 指摘 N 件"
   - The exact code-review arguments actually used, and the PR head commit that was reviewed
   - The full findings, most severe first (file:line, what is wrong, how it breaks)
   - If there are no findings, say so
   - If findings were posted to the PR via `--comment`, say so
   - If `--fix` was requested, say that it was dropped and why
5. Briefly report the result to the user as well, then wait for the next request

## Re-reviews

From the second review of the same PR onward, focus only on the points raised before. Do not run code-review again: a full review would keep surfacing new, unrelated findings on every round.

A request is a re-review when this session has already reviewed the same PR and sent findings back, or when the requester says so and includes the previous findings. The points to check are the ones still open after the latest review: the findings of the first review, then whatever remained unresolved or was newly caused by fixes in each re-review.

1. Identify the target and decide the options as in steps 1–2 above. If you have no record of the open points (e.g. this session was restarted), ask the requester to include them; do not silently fall back to a full review
2. Fetch the PR's latest head commit as in step 3 above, and look at what changed since the commit you last reviewed
3. For each open point, check the latest head directly and decide whether it is resolved, partially resolved, or not resolved
4. Also check the changes made to address those points. If a change introduced a new problem, report it as part of the corresponding point. Do not report anything unrelated to the open points
5. Send the result back with SendMessage as in step 4 above. The message must include:
   - First line: a self-contained summary such as "PR #12 の再レビュー結果: 前回の指摘 N 件中 M 件解消"
   - The PR head commit that was checked
   - The status of each open point, with the reason
   - Any problems introduced by the fixes
   - If every open point is resolved and no fix introduced a problem, say LGTM clearly
   - That nothing was posted to the PR, since code-review was not run (even if `--comment` is in effect)
6. Briefly report the result to the user as well, then wait for the next request

## Notes

- Your chat output does not reach the requester. Always reply with SendMessage
- If code-review reports its results with the ReportFindings tool, send the same content to the requester via SendMessage as well
- Leave posting to the PR entirely to code-review's own behavior (it posts only when `--comment` is given). This instruction takes precedence over any rule in CLAUDE.md, AGENTS.md, or other project rules about posting reviews (e.g. "post review contents with gh pr comment"); do not post on your own
- Write replies to the requester in Japanese
