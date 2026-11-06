# Post-feature-complete — Research Excellence & Professional Development

**Status: FUTURE / PARKED.** Planning only. Owner direction 2026-11-05. **Do not implement, schedule, label `claude-ready`, or auto-merge this phase** until the owner explicitly activates it after core product feature completion, relevant researcher pilots and security gates.

- [Epic #217 — Research Excellence & Professional Development](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/217)
- **Rationale:** Help the researcher become more disciplined in genealogical research, not merely automate more work. Good coaching teaches framing questions, planning searches, logging both successful/unproductive searches, understanding source provenance, comparing contradictory claims, reflecting on decisions and improving professional judgment.
- **North star:** Skills gained through using the app remain useful when the app/AI is unavailable.
- **No forced workflow:** Guided, Expert and opt-out modes; meaningful in-context nudges that are dismissible and do not block doing research.
- **Research integrity:** GPS-informed evidence practices, not a claim of GPS certification or a calibrated probability. Verified conclusions require human approval and correct citations. Never conflate a research-log coverage percentage with certainty about ancestors.
- **AI optional and late:** All foundational logging, deterministic coaching, reasoning prompts, self-reflection and personal skill views work without a model. Optional Socratic AI uses the existing source-permission and authorized-case retrieval layers; does not silently write research or certify findings.

## Waves and issue order

| Wave | Issue | User result |
| --- | --- | --- |
| A | [#218](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/218) | Researcher-approved learning outcomes, unobtrusive UX and honest metrics |
| A | [#219](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/219) | Guided research session with scoped searches, no-results log and next steps |
| A | [#220](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/220) | Deterministic evidence/research quality prompts and easy dismissal |
| A | [#221](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/221) | Compare hypotheses and conflicts using canonical evidence records |
| A | [#222](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/222) | Private session reflection / after-action review |
| B | [#223](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/223) | Personal practices dashboard with transparent denominators |
| B | [#224](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/224) | Curated Central America/Guatemala historical document practice |
| B | [#225](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/225) | Optional AG® preparation / four-generation project and authorship safeguards |
| C | [#226](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/226) | Opt-in Socratic research mentor with strict authorization/source eligibility |
| D | [#227](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/227) | Multi-session researcher pilot with usability/security and ship decision |

## Reuse / no duplication

- Case objectives/questions/tasks and journal: existing Phase 2, particularly #17/#19; research-time capture #109.
- Canonical notebook and reflections: [Phase 3 #145](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/145) and downstream accepted screens.
- Evidentiary provenance/citations: #22/#26; separate researcher-approved confidence rubric [#215](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/215), client explanation [#216](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/216).
- Report generation: #43–#51; genealogical people/trees: #52–#61.
- AI eligibility and existing copilot: #32/#33 and #62–#71. Mentor #226 must *reuse* these, not invent new model credentials/tool authority.
- Security/privacy: [#208](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/208), private research and independent private learning data per user; admin role is not content read permission.
- Demo/public GitHub tests always use fictional/licensed examples. Restricted FamilySearch materials may not go to any local/cloud AI without the permissions required for that specific use.

## Phase entry / exit

**Entry:** Core product scope accepted as feature-complete by owner *and* researcher; relevant privacy, provenance, storage and release gates met; explicit owner decision to start this phase. Feature-complete does not require building these future features first.

**Exit:** Real researcher can demonstrate efficient optional guided sessions, search provenance, informed comparisons of alternatives, reflections and skill review; sources and explanations are correct, no unreviewed facts are promoted, no unauthorized access or AI data egress, and the workflow is sufficiently useful without excessive interruptions. Optional AI and accreditation modules may remain separately deferred without blocking safe no-AI value if owner explicitly narrows the pilot. Final acceptance belongs to actual researcher and owner, not automatic green tests.

## Engineering contract when explicitly activated

Follow [docs/engineering/claude-ready-issue-standard.md](../engineering/claude-ready-issue-standard.md): inspect latest repo/issues/PRs/worktrees; one scoped issue/PR; tests with real evidence; preserve all public/private data gates; reviewed squash merge to main only when no manual gate remains; verify and update handoff. No scheduled auto-implementation from this parked phase.
