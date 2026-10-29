# Researcher workflow review — completed questionnaire (2026-10-28)

**Project:** Tracing Guatemala desktop app  
**Source:** Completed four-page *Tracing Guatemala — Current Research Workflow* questionnaire, returned by the researcher.  
**Scope:** De-identified, researcher-confirmed discovery notes. Do not include client identities, records, or case details in this public repository.

## Validation

- The researcher selected **“Yes, this is right” for all ten steps**.
- She wrote **“All steps are accurate”** when asked whether any were missed or out of order.
- Her overall assessment was **“Mostly accurate”**.
- Important distinction: she confirmed the **current process**, while the automation ideas below are **desired future capabilities**, not implemented or approved Phase 1 scope.

## Confirmed current workflow

1. **Fiverr order arrives:** Check purchased service/package, order details, and deadline.
2. **Review intake:** Read the questionnaire, known people, research goals, and client-provided material.
3. **Clarify objective:** Copy the questionnaire into ChatGPT to summarize the research goal and outline relationships as a narrative/tree.
4. **Build working tree:** Enter known relatives and relationships into a private Ancestry tree. The client narrative may need to be reread to establish pedigree structure.
5. **Search historical sources:** Research potential matches using FamilySearch and other sources.
6. **Reconcile facts:** Compare and evaluate inconsistent dates, names, places, and relationships manually.
7. **Save sources:** Store files and references in FamilySearch folders and on the researcher's laptop.
8. **Log research:** Manually copy records/details into OneNote and write interpretations, hypotheses, and next steps.
9. **Prepare report:** Reread OneNote notes and ask ChatGPT to draft a professional genealogy report.
10. **Deliver:** Send drafts/final deliverables to the client using the current Fiverr process.

### Repeat-client handling

- Repeat clients receive **personalized gig proposals** through Fiverr messaging; the researcher may also use email in coordinating the proposal.
- Fiverr permits selecting a package and **customizing the offered price**.
- The researcher reported **no delays or incomplete orders so far**. Do not interpret this as a defined exception/cancellation workflow.

## Highest-friction tasks (researcher's own ranking)

1. **Saving the same information multiple times:** FamilySearch folder, local laptop folder, then OneNote.
2. **Populating the OneNote research journal:** Recording facts, relationships, interpretations, and associated documents is time-consuming.
3. **Composing client messages in ChatGPT:** Especially delivery messages that depend on the client's goals and purchased package/tier.

## Desired capabilities captured from step-by-step feedback

| Step | Requested improvement | Future-scope reference |
| --- | --- | --- |
| 3. Goal clarification | Automatically turn the questionnaire into a concise research objective plus a family relationship summary/tree, without copying it into ChatGPT. Require researcher review of inferred meaning. | #13 (intake); #62 (AI boundaries); #67 (suggested research steps) |
| 4. Family tree | Draft a pedigree from client-supplied relationships instead of repeatedly rereading intake. Preserve uncertainty and allow edits. | #52, #54, #68 |
| 5. Source search | Recommend which family member to investigate first, balancing the client's objective and the amount/quality of available information. | #67 |
| 6. Fact validation | Detect suspicious relationships/document conflicts; let researcher **review, approve, or reject** each alert. | #58, #65, #68 |
| 7. Document filing | Establish consistent **client- and document-type-aware filenames/organization**. | #22, #25, #29 |
| 8. Research log | Automatically feed saved records/citations into a structured notes/journal view, preserving the researcher's own interpretations and hypotheses. | #18, #25 |
| 9. Reporting | Prepare a report from the research journal and update a **draft** when new approved findings/sources arrive; no silent publication of changing conclusions. OneNote connection remains an integration/design question. | #47, #49, #72 |
| 10. Client delivery | Prepare tailored **draft** client messages using goals and Fiverr package/tier. Sending requires approval until boundaries are explicitly decided. | #43, #88 |

These are discovery findings and candidate backlog refinements, **not commitments to ship in Phase 1**. Existing roadmap phases for evidence, AI, trees, reports, and external integrations should remain intact.

## Phase 1 consequences

- Represent **clients** separately from **orders/custom offers** and, ultimately, **research cases**; support repeat purchases without duplicate client identities.
- Capture **client source (Fiverr)**, purchased package/tier, order deadline and reference, goal (unaltered original), working goal summary, client contact activity, and notes. Exact required fields still need approval (#2).
- Consider modeling a customized repeat-client offer with original package plus negotiated price, without assuming direct Fiverr API access.
- Expose links/references to research materials and later cases; do not implement OneNote or FamilySearch syncing in Phase 1.
- Treat AI-drafted text and inferred family relationships as **proposals for review**, not authoritative genealogy evidence.

## Questions still unresolved

1. What is the actual process for prospects, inactive clients, canceled work, and client follow-up after delivery?
2. Which profile fields are **required** versus optional at first intake?
3. Can a single client have multiple active orders and can one order contain multiple independent research cases?
4. When and how are goal summaries, clarifying questions, drafts, revisions, and delivery messages approved?
5. How should purchased research hours be tracked, separated from tree-building, transcription, and report writing?
6. Which uploaded records/client details may be processed by an external AI provider? How is consent handled?
7. What actions must **never** happen without the researcher's confirmation? The questionnaire answer was **“Not sure”**. Until decided, do not automate irreversible changes, external sends, or acceptance of inferred genealogy facts.
8. What exactly should remain in OneNote versus the new app, and can supported integration permissions be obtained?
9. What should the application do for late, interrupted, incomplete, refunded, or disputed engagements? No such cases have yet occurred.

## Validation status / next step

The 10-step picture and order are confirmed as **mostly accurate**. This validates the baseline discovery, **not** completion of all Phase 1 client-management acceptance criteria. Keep #1 open until remaining lifecycle/field/approval questions are reviewed. Cross-link confirmed details to #2 and #13 as appropriate.

**Source preservation:** The original completed PDF was supplied in the project discussion. The above is the repository-safe text record; the original questionnaire is not embedded here. Add a direct issue attachment when an attachment-capable GitHub workflow is available.
