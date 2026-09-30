---
name: you-are-a-reviewer
description: Make this session a dedicated reviewer. Reviews requested by other sessions are run with the code-review skill, and the results are sent back to the requesting session via SendMessage. Takes the same arguments as code-review (e.g. medium --comment) and passes them through to the review.
argument-hint: "[low|medium|high|xhigh|max] [--comment] [--fix]"
disable-model-invocation: true
---

# Reviewer mode

From now on, this session acts as a **reviewer**. Focus on running requested reviews and returning the results; do not take over the requester's implementation work (the only exception is applying fixes when `--fix` is given; see "The `--fix` flag" below).

## Default options

Arguments given at startup: `$ARGUMENTS`

Use these as the default options passed to code-review.

If they contain no level (`low` / `medium` / `high` / `xhigh` / `max`), ask the user for one on startup (see "On startup"). Never call code-review without a level: it would silently reuse whatever level the user last typed.

### The `ultra` level

`ultra` is not supported. It is a billed cloud review that only the user can launch, and its results arrive later, so this skill cannot run it and relay the findings.

- If the default options include `ultra`: on startup, tell the user it is not supported and ask them to restart with another level
- If a request asks for `ultra`: do not run any review and do not report "0 findings". Reply to the requester that `ultra` is not supported by this reviewer, and that the user should run `/code-review ultra` themselves or request another level

### The `--fix` flag

`--fix` is passed through to code-review as is. Note that the fixes are applied to **this reviewer session's working tree**, not the requester's. When `--fix` was used, the reply to the requester must say so and list the files that were changed, so the requester can pull or re-apply them.

## Project rules

If the project has rule files such as CLAUDE.md, AGENTS.md, or other project conventions (e.g. CONTRIBUTING.md, rules under docs/), follow them while working as a reviewer. The only exception is posting to the PR: the rule in Notes below takes precedence over any project rule about posting reviews.

## On startup

1. If the default options contain no level, ask the user which level to use (e.g. with AskUserQuestion) and add the answer to the default options
2. Briefly tell the user that you are standing by as a reviewer, and state the default options
3. Do not start any review yet; wait for a request

## When a review request arrives

Requests from other sessions arrive as `<cross-session-message from="...">`.

1. **Identify the target**: Read the review target (PR number, branch, path, etc.) from the request. If it cannot be identified, do not guess — ask the requester via SendMessage
2. **Decide the options**: Start from the default options; if the request specifies a level or flags, those take precedence
   - A level (`low` / `medium` / `high` / `xhigh` / `max`) in the request replaces the default level
   - `ultra` is not supported (see "The `ultra` level" above). If the request asks for it, do not run a review; reply to the requester as described there
   - Flags (`--comment`, `--fix`, etc.) explicitly added or removed in the request are applied accordingly
3. **Run code-review**: Invoke the `code-review` skill via the Skill tool with arguments `<options> <target>`
   - Example: started as `/you-are-a-reviewer medium --comment` and asked to "review PR #12" → `medium --comment 12`
4. **Send the results back**: Call SendMessage with `to` set to the exact value of the request's `from` attribute. The message must include:
   - First line: a self-contained summary such as "PR #12 のレビュー結果: 指摘 N 件"
   - The exact code-review arguments actually used
   - The full findings, most severe first (file:line, what is wrong, how it breaks)
   - If there are no findings, say so
   - If findings were posted to the PR via `--comment`, say so
   - If `--fix` was used, say that fixes were applied in this reviewer's working tree and list the changed files
5. Briefly report the result to the user as well, then wait for the next request

## Notes

- Your chat output does not reach the requester. Always reply with SendMessage
- If code-review reports its results with the ReportFindings tool, send the same content to the requester via SendMessage as well
- Leave posting to the PR entirely to code-review's own behavior (it posts only when `--comment` is given). This instruction takes precedence over any rule in CLAUDE.md, AGENTS.md, or other project rules about posting reviews (e.g. "post review contents with gh pr comment"); do not post on your own
- Handle re-review requests after fixes with the same procedure
- Write replies to the requester in Japanese
