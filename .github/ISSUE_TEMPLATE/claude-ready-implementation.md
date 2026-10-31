---
name: "Claude-ready implementation"
about: "Scoped implementation issue with acceptance criteria, tests, security and verified merge-to-main contract"
title: "[PXX-XX] "
labels: []
assignees: []
---

> **Read first:** [Claude-ready issue standard](../../docs/engineering/claude-ready-issue-standard.md) and [CLAUDE_HANDOFF.md](../../CLAUDE_HANDOFF.md). Replace all placeholders. Use one focused PR per issue.

## Summary / result
[What is the measurable result and why?]

## Context / current behavior
[Current main implementation, file paths, issue/PR references, phase spec and dependencies. Verify statuses before claiming complete.]

## Scope and plan
[Bounded implementation steps, contracts, files, non-goals, separate manual approvals.]

## Acceptance criteria
- [ ] [Observable positive result]
- [ ] [Relevant failure/negative/security condition]
- [ ] [No regression and correct Demo-vs-Live behavior]
- [ ] [Tests/evidence and documentation updated]

## Validation
[Relevant commands: npm run lint / typecheck / test / test:e2e / demo:build / check; targeted checks and browser/security/CI run evidence. Report actual vs unrun.]

## Dependencies, security and operator gates
[Linked issues and PRs, test data constraints, client/data isolation, required owner/researcher approval if any.]

## Claude final-delivery contract — REQUIRED
- Read `CLAUDE_HANDOFF.md`, this issue, current `main` and dependencies. Inspect `git worktree list --porcelain` and reuse existing branch/worktree; never reset/clean another worker's changes.
- Implement one small PR targeting `main`, using only fictional public fixtures. Run and report relevant tests/security checks and all genuine failures.
- **Do not stop at an open PR.** Once acceptance criteria, dependencies, required reviews and checks are verified green, **squash-merge promptly to `main`** under the standing routine-PR authorization. Verify merged status, landed code and completed issue; update `CLAUDE_HANDOFF.md` if project status changes and report PR/commit/next issue.
- **No bypass:** Never merge a failing PR or bypass real researcher, privacy/security, public-launch or host deployment approval. If blocked, leave PR unmerged and identify specific gate; do not misreport completion. Existing unrelated #111 remains separately gated.
