import type { CaseBrief } from '../../../shared/case-brief'
import type { JournalEntry } from '../../../shared/case-journal'
import type { CaseEvent, ResearchCase } from '../../../shared/case-model'
import type { CaseSummaryData } from '../../../shared/case-summary'
import type { CaseTask } from '../../../shared/case-tasks'

// Case summary export (#20), browser side. The summary is composed here from the
// selected case's own scoped calls (all reads) and saved with an ordinary browser
// download (downloadText.ts). Nothing is sent to the host and nothing is written to
// the app's data. Shared UI: no imports from demo/ or web/. This file has no DOM
// and no React so the host tests can run the real loader over HTTP.

/**
 * The only calls the export may make, all reads. Any AppRuntime satisfies this, and
 * a runtime without case support (`cases: null`) cannot export.
 */
export interface CaseSummarySource {
  data: { getClient(id: string): Promise<{ id: string; displayName: string } | null> }
  cases: {
    getCase(id: string): Promise<ResearchCase | null>
    getCaseBrief(caseId: string): Promise<CaseBrief | null>
    listJournalEntries(caseId: string): Promise<JournalEntry[]>
    listCaseTasks(caseId: string): Promise<CaseTask[]>
    listCaseEvents(caseId: string): Promise<CaseEvent[]>
  } | null
}

/**
 * Everything the summary needs for ONE case, from that case's own calls. Null when
 * the case or its client no longer exists. Only the client's id and display name are
 * kept: the rest of the client record never enters the summary data.
 */
export async function loadCaseSummaryData(source: CaseSummarySource, caseId: string): Promise<CaseSummaryData | null> {
  const cases = source.cases
  if (!cases) throw new Error('This app has no case support.')
  const researchCase = await cases.getCase(caseId)
  if (!researchCase) return null
  const [client, brief, journal, tasks, events] = await Promise.all([
    source.data.getClient(researchCase.clientId),
    cases.getCaseBrief(researchCase.id),
    cases.listJournalEntries(researchCase.id),
    cases.listCaseTasks(researchCase.id),
    cases.listCaseEvents(researchCase.id)
  ])
  if (!client) return null
  return {
    client: { id: client.id, displayName: client.displayName },
    case: researchCase,
    brief,
    journal,
    tasks,
    events
  }
}
