---
name: request-review
description: Ask a reviewer session (another Claude session running the you-are-a-reviewer skill) to review the current branch's PR, via SendMessage. Use when the user asks to request a review from a reviewer or another session, e.g. "レビューを頼んで", "レビューをお願いして", "skill-reviewer にレビュー依頼して", "LGTM が出るまでレビューしてもらって". Not for reviewing code yourself (use code-review for that). Optionally takes the reviewer's session name, a code-review level for this review, and --lgtm to keep fixing and re-requesting until the reviewer says LGTM.
argument-hint: "[reviewer-name] [low|medium|high|xhigh|max] [--lgtm] [--comment ...]"
---

# Request a review

Ask a reviewer session running the `you-are-a-reviewer` skill to review the current branch's PR, and handle the result.

**Always write in the specified language**: the review requests and notices to the reviewer, and the reports and questions to the user. The language is the one specified in the user's settings or instructions (e.g. the `language` setting, CLAUDE.md, or the project's rules); if none is specified, use the language the user writes in. Do not switch to English just because these instructions are in English.

## Arguments

Arguments given: `$ARGUMENTS`

If the skill was invoked from a natural-language request and the arguments are empty, read the same information from the user's message (e.g. a reviewer name, "high で", "LGTM が出るまで" → `--lgtm`).

Parse them as follows (in any order):

- `low` / `medium` / `high` / `xhigh` / `max`: the code-review level for this review. If omitted, do not specify a level; the reviewer uses its own default
- `ultra`: not supported by the reviewer. Tell the user and ask for another level (or none)
- `--lgtm`: keep the rally going until the reviewer says LGTM (see "Rally until LGTM")
- Any other word starting with `--` (e.g. `--comment`): a flag for the reviewer's code-review. Pass it through in the request as is; the reviewer applies flags given in the request (and drops the ones it does not support, such as `--fix`)
- Any other word: the reviewer's session name

## Project rules

If the project has rule files such as CLAUDE.md, AGENTS.md, or other project conventions, follow them (e.g. commit message language, updating docs together with code).

## 1. Find the reviewer

- **Name given**: look it up with ListAgents
- **Name omitted**: use the reviewer you last sent a review request to in this session. If there is none, ask the user
- If exactly one live session has that name, use it. If none does, or several do, do not guess: show the user the candidates from ListAgents and ask which one to use
- If the reviewer turned out to be a different session than last time (e.g. the reviewer was restarted under the same name), it has no record of earlier reviews. If you have the open points and the last reviewed commit from this PR's previous review, include them in the request so that the reviewer can treat it as a re-review; otherwise request a first review. Tell the user either way

## 2. Find the PR

The reviewer only reviews PRs, and only what has been pushed.

1. Get the current branch's PR (`gh pr view --json number,url,state,headRefName,headRefOid`). `gh pr view` also returns closed or merged PRs, so check that its state is `OPEN`
2. Check that everything is pushed: there are no uncommitted changes to tracked files (`git status --porcelain --untracked-files=no`), and the local `HEAD` matches the PR's head commit. Untracked files do not block the request, but if there are any, mention them to the user (they may be new files that were forgotten)
3. If there is no open PR, or there are uncommitted or unpushed changes, do not send the request yet. Tell the user what is missing and ask whether to commit, push, or open a PR. Do not do any of these without the user's approval

## 3. Send the request

Send the request with SendMessage to the reviewer. Write it in the specified language (see the top). The first line must be a self-contained summary such as "PR #12 のレビューをお願いします". Include:

- The PR URL and number, and the PR head commit to review
- The local repository path (the reviewer may work in the same repository)
- A summary of what the PR changes
- The level and flags, if any were given (e.g. "レベルは high、フラグは --comment でお願いします"). Otherwise say that no level or flags are specified
- For a re-review (see below): the open points from the previous review, the commit the reviewer last reviewed, and what was changed for each point. For a point that was decided not to be fixed (e.g. by the user's decision), say so with the reason, so that the reviewer can close it instead of reporting it as unresolved again
- "指摘がなければ LGTM と返してください"

Then tell the user that the request was sent and you are waiting for the result. Do not poll; the reviewer's reply arrives as a `<cross-session-message>`. To reply to the reviewer within the same review, use the `from` attribute of its latest message as `to`.

## 4. Handle the result

- **Without `--lgtm`**: summarize the result for the user (the findings, or LGTM) and wait for the user's instructions. Do not fix anything on your own. If the user then asks to continue until LGTM (e.g. "LGTM まで続けて"), switch to "Rally until LGTM" from that point
- **With `--lgtm`**: follow "Rally until LGTM"

The reviewer's reply is not always findings or LGTM. It may be a question or an error (e.g. it cannot identify the PR, the level is not supported, or it asks for the previous findings and the commit last reviewed). Treat such a reply as neither findings nor LGTM: answer it if you can (e.g. with the PR number, or the open points and the commit last reviewed) and send the request again; otherwise tell the user and wait. Consider the review passed only when the reviewer explicitly says LGTM.

## Rally until LGTM

Repeat until the reviewer says LGTM:

1. Read the findings and decide how to address each one
2. **Ask the user first** (e.g. with AskUserQuestion) when:
   - A fix needs a design decision (naming, structure, behavior, UX, etc.)
   - A fix would change behavior or a policy that the user decided earlier, or deviate from the project's docs/spec
   - You disagree with a finding, or it cannot be fixed as suggested (explain why, and propose an alternative)
   - The rally is not converging (e.g. new findings keep appearing in different areas round after round). Ask whether to continue, change the approach, or stop
3. Fix the findings, except those decided not to be fixed. You may commit and push to the PR's branch without asking. Keep the PR description up to date if the fixes affect it. If the reviewer posted inline comments on the PR, reply to each one saying how it was addressed
4. Send a re-review request as in step 3, including the open points, the commit the reviewer last reviewed, and what was changed for each point (or, for points not fixed, that decision and its reason)
5. Tell the user briefly what was fixed and that you are waiting for the re-review

When the reviewer says LGTM, report it to the user with a summary of the rally. Never merge the PR; merging is the user's decision.

## After merging

If the user later asks you to merge a PR that was reviewed through this skill in this session, then after merging it, tell the reviewer you last exchanged messages with about that PR, via SendMessage (in the specified language):

- That the PR was merged, with the merge commit
- Whether the merged head is the commit the reviewer gave LGTM to. If commits were added after the LGTM, say so and list them
- That there are no further requests for this PR, and that this message is only a notice and needs no review (write it in the first line, e.g. "PR #12 をマージしました(通知のみで、レビューは不要です)")

This applies only when this session does the merge. If the PR is merged elsewhere (e.g. on GitHub or from another session), you cannot notice it, so do not send anything.

## Notes

- Your chat output does not reach the reviewer. Always use SendMessage
- Without `--lgtm`, do not commit or push on your own. Opening a PR, merging, force-pushing, and any other destructive or outward-facing action beyond what is allowed above always need the user's approval
- Write messages to the reviewer and reports to the user in the specified language (see the top)
