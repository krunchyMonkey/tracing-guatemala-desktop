## Summary

<!-- What changes and why. One issue per PR. Use "Refs #N" unless every acceptance criterion is verified. -->

Refs #

## Validation

<!-- GitHub-hosted CI run links for the head SHA. Name anything that did not run. Fictional data only. -->

- [ ] CI green for the head SHA: <!-- run link -->
- [ ] Tests, screenshots and logs use fictional data only

## Security-sensitive?

Does this PR touch auth, Google identity or recovery; ownership, grants or authorization; schema migrations or legacy reconciliation; backup, restore or rollback; research privacy or isolation between users; sessions or sensitive API boundaries; or production configuration? See [the security review gate](https://github.com/krunchyMonkey/tracing-guatemala-desktop/blob/main/docs/engineering/security-review-gate.md).

- [ ] **No.** The normal merge policy applies.
- [ ] **Yes.** Complete the checkpoint below. Do not merge until it is done.

### Final security review checkpoint (security-sensitive PRs only)

- [ ] Independent security review by an agent that did not write the code; every finding fixed or recorded as non-blocking
- [ ] Copilot comments, if any, answered with a disposition
- [ ] Review package posted as a PR comment for head SHA `<sha>`
- [ ] Status set to `Awaiting owner + ChatGPT security review`
- [ ] Owner + ChatGPT final review is acceptable for head SHA `<sha>`
- [ ] Owner gave explicit source-merge authorization for this PR at this SHA

Source merge does **not** authorize deployment, real-data migration, legacy claims, real backup or restore, or Live changes. Those need the #211 gates.

<!--
Review package skeleton (post as a PR comment):

## Security review package — <PR URL> @ <full SHA>
Status: Awaiting owner + ChatGPT security review

1. PR and commit:
2. Files changed (security-relevant changes):
3. Threat model (assets, trust boundaries, attacker capabilities, abuse paths):
4. Invariants:
5. Review and Copilot findings, with dispositions and fixing commits:
6. Automated tests and CI links for this SHA:
7. Negative-path tests (unauthorized, stale session, malformed, interrupted, concurrent):
8. Data preservation, backup, rollback, recovery:
9. Unresolved risks (blocking / non-blocking):
10. Untested assumptions and limitations:
-->
