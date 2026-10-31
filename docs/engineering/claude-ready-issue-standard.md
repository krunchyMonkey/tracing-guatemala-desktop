# Claude-ready GitHub issue standard (owner direction 2026-10-31)

**Applies to every future Tracing Guatemala implementation issue in every phase.** Use this standard when ChatGPT or Claude creates/grooms tickets. [`CLAUDE_HANDOFF.md`](../../CLAUDE_HANDOFF.md) is the agent starting point; GitHub is the planning/status source; code/tests on `main` are the implementation source.

## Required content for every implementation ticket

1. **Summary and result:** observable user/engineering outcome, why it matters and what is not in scope. Avoid bundled unrelated features.
2. **Context:** current `main` behavior and relevant codepaths, links to governing phase spec/parent issues/PRs, current blockers and the real dependency order. Verify status in GitHub; never assume completion because an old handoff says so.
3. **Implementation plan:** actionable bounded steps and interfaces, web-first React/TypeScript/Node; keep Electron preserved but paused. Prefer one small testable PR per issue, use current shared contracts/adapters, avoid speculative abstractions.
4. **Acceptance criteria:** independently verifiable checklist items including failure/negative cases, data isolation, security/privacy, mobile/web behavior as appropriate; distinguish manual approvals from engineer-completable steps.
5. **Testing:** exact relevant lint/type/Vitest/Playwright/build/security commands, expected outcomes, artifact evidence and honest unrun items. Prefer `npm run check` plus targeted tests; run CI once introduced. No claims of passing tests without evidence.
6. **Data/security rules:** fictional data only in public code/CI/demo; no real names, records, screenshots, logs, addresses, session cookies, keys, secrets or backend paths exposed. Respect HTTPS-only privacy approvals, user auth, backup, client isolation, browser origin/CSP controls. Do not use remote/cloud resources without authorized design.
7. **Branch/worktree/PR delivery:** inspect `git worktree list --porcelain` and GitHub open branches/PRs; reuse existing worktree where possible; never reset/clean/delete the user's work. Target `main` unless a clearly declared stacked PR dependency is needed.
8. **Final merge contract:** include the mandatory merge-on-completion instructions below *in every implementation ticket*, not merely the epic or the handoff.

## Mandatory closeout language (paste into each issue)

> **Claude final-delivery contract — merge to main**
>
> - Read `CLAUDE_HANDOFF.md`, this issue, current `main`, open PRs and dependencies. Work in the existing appropriate worktree/branch where possible; avoid destructive operations. Use fictional data in tests and public GitHub.
> - Implement one scoped, testable PR with appropriate regression/security tests. Run relevant lint, typecheck, unit, integration, browser E2E and builds; report genuine results, known flaky failures and skipped/unrun checks.
> - **Do not stop at a locally completed branch or an open PR.** When acceptance criteria are satisfied, all required automated checks/reviews pass, dependencies are merged, and no owner/researcher/security gate remains, **squash-merge the PR into `main` promptly** under the owner's standing routine-PR authorization.
> - After merging, **verify on GitHub that the PR is merged**, the commit is present on `main`, and issue state reflects actual completion. Update `CLAUDE_HANDOFF.md` when project status or architectural direction changes. Report PR/commit and next unblocked issue.
> - **Do not bypass manual gates:** never merge a failing/blocked PR; never merge an unresolved review or assume researcher approval (#21/#157), HTTPS real-data approval (#168/#169), public-demo launch approval, production migration/cutover approval, or required owner security/privacy decisions. If gated, leave PR unmerged, identify the exact hold and affected issue, and proceed only with independent permitted work. Exclude unrelated PR #111 from this authorization.

## Explicit distinction: merge vs deployment

A merged commit on `main` is not automatically deployed. A private Live release requires its separate tested/deployed/healthy state and all privacy approvals. Phase 2.9 owns CI/build/publishing/version promotion, and an approved Demo promotion is based on the **same tested source SHA** as a verified Live release. Keep the fictional public Demo statically hosted and inaccessible to private backend/data. Do not turn “merge promptly” into “deploy real records” or “publish publicly without signoff.”

## Ticket author checklist

- [ ] Parent phase, concrete dependencies and blockers linked; one issue / one PR-sized slice.
- [ ] Measurable acceptance, failure modes, tests and security considerations.
- [ ] Worktree/reuse rules, implementation files and relevant current specs.
- [ ] **Mandatory final-delivery contract included** in issue body.
- [ ] If scope requires approval, explicitly state the owner/researcher approval gate without imposing approval on unrelated work.
- [ ] Future reader can begin implementation without a discovery meeting; handoff updated when needed.
