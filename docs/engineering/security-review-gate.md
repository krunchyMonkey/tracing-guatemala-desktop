# Final security review gate: owner + ChatGPT (owner direction 2026-11-12)

A security-sensitive pull request merges only after the project owner (KK) has reviewed it **together with ChatGPT** at an exact commit, and then given explicit source-merge authorization for that PR.

Claude's own review, independent AI agent reviews, Copilot comments and green CI are **supporting evidence**. None of them is final approval.

This gate overrides the routine merge-on-completion policy in the [Claude-ready issue standard](claude-ready-issue-standard.md) for the PRs it covers.

## Which PRs need it

A PR needs the gate if it changes any of these:

- authentication, Google identity binding or account recovery;
- research ownership, grants, permissions or authorization;
- database schema migrations or legacy data reconciliation;
- backup, restore, rollback or data recovery;
- client research privacy and isolation between users;
- session management or sensitive API boundaries;
- production configuration or how data is preserved.

In Phase FIX this includes #257 (#245), #258 (#246-a), and the security-sensitive parts of #255, #246, #247 and #212.

It does **not** apply to ordinary documentation, styling, test-only flake fixes or unrelated low-risk changes. Those follow the normal policy. If you are unsure, apply the gate and say why in the PR.

## Workflow

1. **Implement** on the issue's branch and worktree, with fictional data only.
2. **Review independently.** A fresh agent that did not write the code reviews it for security. Fix every finding on the same PR, or record why it is non-blocking.
3. **Run CI** on GitHub-hosted runners for the exact head commit. Investigate failures honestly, and name flakes by issue number.
4. **Write the review package** (below) and post it as a PR comment. It must name the exact head SHA it covers.
5. **Hand off.** Keep the PR open. Set its status to `Awaiting owner + ChatGPT security review`: say so in the PR body and in the package, and use the label of the same name if one exists. Tell the owner the package is ready.
6. **Stop.** Do not merge, close the implementing issue or deploy. Silence, green CI, an AI review or an earlier authorization (including one for another PR or an earlier SHA) is **not** approval.
7. **If findings come back**, fix them on the same PR, add a targeted regression test for each, rerun CI and post a **new** package for the new SHA. The earlier package no longer applies.
8. **Once the review is acceptable**, wait for the owner's explicit source-merge authorization for that PR. Then merge exactly the reviewed SHA. If the head has moved since the review, the gate applies again.

## The review package

Keep it concise and factual. Every claim about tests must point to a CI run or a command output. If a check did not run, say so.

1. **PR and commit:** PR URL and the exact final head SHA.
2. **Files changed:** each file, with a short explanation of any security-relevant change.
3. **Threat model:** protected assets, trust boundaries, attacker capabilities and possible abuse paths.
4. **Invariants:** the security properties that must stay true.
5. **Review findings:** every independent-review and Copilot finding, with its exact disposition (fixed in `<sha>`, not a defect because…, deferred to #N) and the fixing commit.
6. **Automated tests:** results and CI run links **for the final SHA**.
7. **Negative-path tests:** unauthorized users, stale sessions, malformed requests, interrupted operations and concurrent access, where relevant. Name the test file and case.
8. **Data preservation:** backup, rollback and recovery evidence, or a statement that the PR does not touch stored data.
9. **Unresolved risks:** each one classified as **blocking** or **non-blocking**.
10. **Untested assumptions and limitations.**

A copy-ready skeleton is in the [pull request template](../../.github/pull_request_template.md).

## Source merge never authorizes production

Source-merge approval for a PR never authorizes:

- production deployment;
- a real-data database migration;
- legacy client ownership claims;
- real backup or restore operations;
- changes to Live services or configuration.

Those still need every acceptance gate in #211, including the researcher's informed approval where it applies. See the [privacy rehearsal plan](../operations/privacy-rehearsal-plan.md).
