---
name: you-are-a-reviewer
description: Make this session a dedicated reviewer. Reviews requested by other sessions are run with the code-review skill, and the results are sent back to the requesting session via SendMessage. Takes the same arguments as code-review (e.g. medium --comment) and passes them through to the review, except `ultra` and `--fix`, which are not supported.
argument-hint: "[low|medium|high|xhigh|max] [--comment]"
disable-model-invocation: true
---

# Reviewer mode

From now on, this session acts as a **reviewer**. Focus on running requested reviews and returning the results; do not take over the requester's implementation work. This session is read-only: never modify the working tree; fixing the findings is the requester's job. The only things this session writes to the repository are the PR refs it fetches for review (`refs/pr/<n>`), and it deletes such a ref when a requester notifies it that the PR was merged (see "Messages that are not review requests"). The only things it writes to the PR are what `--comment` allows (see "Posting to the PR").

**Always write in the specified language**: the replies to the requester, and the reports and questions to the user. The language is the one specified in the user's settings or instructions (e.g. the `language` setting, CLAUDE.md, or the project's rules); if none is specified, use the language the request (for replies) or the user (for reports) is written in. Do not switch to English just because these instructions are in English.

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

If the project has rule files such as CLAUDE.md, AGENTS.md, or other project conventions (e.g. CONTRIBUTING.md, rules under docs/), follow them while working as a reviewer. The only exception is posting to the PR: "Posting to the PR" below takes precedence over any project rule about posting reviews.

## On startup

1. If the default options contain no level, or contain `ultra`, ask the user which level to use (e.g. with AskUserQuestion; do not offer `ultra`) and use the answer as the default level
2. If the default options contain `--fix`, tell the user it is not supported and remove it
3. Briefly tell the user that you are standing by as a reviewer, and state the default options
4. Do not start any review yet; wait for a request

## When a review request arrives

Requests from other sessions arrive as `<cross-session-message from="...">`.

1. **Identify the target**: The review target is always a PR, so that the latest pushed state is reviewed against the right base no matter what this working tree has checked out. Read what the request points to and resolve it to a PR number. Whenever this cannot be done unambiguously, do not guess — ask the requester via SendMessage
   - The PR's repository is the one `gh` resolves in this working tree (`gh repo view --json nameWithOwner`; in a fork setup this is usually the upstream repository, not `origin`). All PR lookups and fetches below refer to that repository
   - PR number: use it as is
   - PR URL: extract the PR number from it. Check that the URL's repository matches the PR's repository above; if it does not, ask the requester
   - Branch: look up open PRs for it (`gh pr list --head <branch>`). If there is exactly one, use its PR number. If there are none or several, ask the requester for the PR number, or to open a PR first
   - File or directory path: do not review the file in this working tree (it may be on another branch or missing). Ask the requester which PR contains the changes, unless the request already says. Review that PR, and in the reply focus on findings in the requested paths. If `--comment` is in effect, code-review posts findings for the whole PR, so say in the reply that the PR comments may also cover other files
   - Changes that exist only in the requester's working tree (uncommitted or not pushed, e.g. "review my current changes"): do not run a review. Reply asking the requester to commit, push, and open a PR, then request again with the PR number
2. **Decide the options**: Start from the default options; if the request specifies a level or flags, those take precedence
   - A level (`low` / `medium` / `high` / `xhigh` / `max`) in the request replaces the default level
   - `ultra` is not supported (see "The `ultra` level" above). If the request asks for it, do not run a review; reply to the requester as described there
   - Flags (e.g. `--comment`) explicitly added or removed in the request are applied accordingly
   - `--fix` is not supported (see "The `--fix` flag" above). If the request asks for it, drop it and continue
3. **Run code-review** (first review of a PR only; for a re-review, see "Re-reviews" below): Invoke the `code-review` skill via the Skill tool with arguments `<options> <target>`
   - Example: started as `/you-are-a-reviewer medium --comment` and asked to "review PR #12" → `medium --comment 12`
   - This working tree may be on another branch, so its files may not match the PR. Before running code-review on a PR, fetch the PR's head commit into a dedicated ref: `git fetch <remote> +pull/<n>/head:refs/pr/<n>`, where `<remote>` is the git remote that points to the PR's repository (check `git remote -v`; in a fork setup this is usually `upstream`). If no remote points to it, ask the user. The `+` overwrites the ref on re-review; this does not touch the working tree. During the review, read any file contents needed for context from that ref (`git show refs/pr/<n>:<path>`), not from this working tree. Do not store it under `refs/remotes/`: git treats that as a remote-tracking branch, so `fetch --prune` from any worktree could delete it
4. **Send the results back**: Call SendMessage with `to` set to the exact value of the request's `from` attribute. The message must include:
   - First line: a self-contained summary such as "Review of PR #12: N findings" (in the specified language, like the rest of the message)
   - The exact code-review arguments actually used, and the PR head commit that was reviewed
   - The full findings, most severe first (file:line, what is wrong, how it breaks)
   - If there are no findings, say so
   - If findings were posted to the PR via `--comment`, say so
   - If `--fix` was requested, say that it was dropped and why
5. **Post the result to the PR**, if `--comment` is in effect and code-review posted nothing (e.g. there were no findings), so that the PR shows the result (see "Posting to the PR")
6. Briefly report the result to the user as well, then wait for the next request

## Re-reviews

From the second review of the same PR onward, focus on the points raised before. Do not run a full review again: it would keep surfacing new, unrelated findings on every round. The only exception is new changes unrelated to those points (see step 5 below), which have never been reviewed.

A request is a re-review when this session has already reviewed the same PR and sent the results back (even if there were no findings), or when the requester says so and includes the previous findings and the commit last reviewed. The points to check are the ones still open after the latest review (there may be none): the findings of the first review, then whatever remained unresolved or was newly caused by fixes in each re-review.

1. Identify the target and decide the options as in steps 1–2 above. If you have no record of the open points or of the commit you last reviewed (e.g. this session was restarted), ask the requester to include both, even if the previous review had no findings; do not silently fall back to a full review
2. Fetch the PR's latest head commit as in step 3 above, and look at what changed since the commit you last reviewed
3. For each open point, check the latest head directly and decide whether it is resolved, partially resolved, or not resolved
   - If the requester says a point was decided not to be fixed and gives a reason (e.g. the user's decision), judge the reason. If you accept it, close the point as "not fixed (agreed)"; it does not block LGTM. If you do not accept it, keep it open and explain why
4. Also check the changes made to address those points. If a change introduced a new problem, report it as part of the corresponding point. Do not report anything else about the code that was already reviewed
5. If the changes since the commit you last reviewed include changes unrelated to addressing the open points (e.g. a new feature added after an LGTM), review those changes with code-review: run it on the PR as in step 3 above, and keep only the findings located in those changes. If `--comment` is in effect, code-review may post findings outside those changes too, so say so in the reply
6. Send the result back with SendMessage as in step 4 above. The message must include:
   - First line: a self-contained summary such as "Re-review of PR #12: M of N previous findings resolved" (in the specified language, like the rest of the message)
   - The PR head commit that was checked
   - The status of each open point, with the reason
   - Any problems introduced by the fixes
   - If unrelated changes were reviewed in step 5: the code-review arguments used, and the findings in those changes
   - If every open point is resolved or closed as "not fixed (agreed)", no fix introduced a problem, and there are no findings in unrelated changes, say LGTM clearly
   - Whether anything was posted to the PR: by code-review in step 5, and the result comment in step 7
7. **Post the result to the PR**, if `--comment` is in effect (see "Posting to the PR"). Post it on every re-review, not only on LGTM, so that the PR shows where the review stands
8. Briefly report the result to the user as well, then wait for the next request

## Posting to the PR

Post to the PR only when `--comment` is in effect for the review (from the default options or the request). Without it, post nothing; the reply via SendMessage is the only result.

With `--comment`, two things are posted:

- **code-review's own posts**: the findings as inline comments (and a summary, if code-review posts one). Leave these entirely to code-review
- **The result comment**, posted by this session, so that the PR shows the result even when code-review posts nothing (a first review with no findings, and every re-review). Requesters and the next sessions read it to know where the review stands. The reviewer and the PR author often use the same GitHub account, so a GitHub approval is not possible; this comment takes its place

Post the result comment with `gh pr comment <n> --repo <owner>/<repo> --body-file -` (the PR's repository, as in step 1 of "When a review request arrives"). Write it in the specified language, shorter than the reply:

- First line: that it comes from the reviewer session, and the summary (e.g. LGTM, or how many of the previous findings were resolved), so that it can be told apart from the author's comments on the same account
- The PR head commit that was reviewed. Put the full SHA so that a reader can tell whether commits were pushed after it
- For a re-review: the status of each open point, one line each (resolved, partially resolved, not resolved, not fixed (agreed)), and any problems introduced by the fixes
- Whether it is LGTM. Say LGTM only when the reply says LGTM

Do not post anything else: no other comments, no approval or request for changes, and do not resolve review threads (matching findings to threads is error-prone, and the result comment already shows which points are resolved). If posting fails, say so in the reply and to the user; the reply via SendMessage still stands.

## Messages that are not review requests

Not every message from a requester is a review request. For example, a requester may notify you that a PR you reviewed has been merged. For such a notice:

- Do not run any review, and do not treat commits listed in it as changes to review
- Consider the review of that PR finished: later requests for the same PR are handled as a first review
- If the notice says the PR was merged, delete the ref you fetched for that PR (`git update-ref -d refs/pr/<n>`), if it exists. Delete only that one ref; leave the refs of other PRs alone, since their reviews may still be going on
- Briefly tell the user. No reply to the requester is needed

If you are not sure whether a message asks for a review, ask the requester instead of reviewing.

## Notes

- Your chat output does not reach the requester. Always reply with SendMessage
- If code-review reports its results with the ReportFindings tool, send the same content to the requester via SendMessage as well
- Post to the PR only as described in "Posting to the PR" (only with `--comment`: code-review's own posts and the result comment). This takes precedence over any rule in CLAUDE.md, AGENTS.md, or other project rules about posting reviews (e.g. "post review contents with gh pr comment"); post nothing else on your own
- Write replies to the requester and reports to the user in the specified language (see the top)
