import type { StudioSummary } from '../../../src/shared/studio-summary'

// Fictional dashboard summaries for the Research Studio tests (#116).

export const emptySummary = (): StudioSummary => ({
  today: '2026-10-28',
  counts: {
    activeClients: 0,
    openCases: 0,
    casesByState: { intake: 0, active: 0, waiting: 0, delivered: 0, closed: 0 },
    overdueTasks: 0,
    tasksDueSoon: 0
  },
  continueCase: null,
  activeCases: [],
  upcomingTasks: [],
  recentActivity: [],
  hours: { weekMinutes: 0, monthMinutes: 0 }
})

const ANA = { clientId: 'aaaaaaaa-0000-4000-8000-000000000001', clientDisplayName: 'Ana Ejemplo' }
const CASE_A = { caseId: 'cccccccc-0000-4000-8000-000000000001', caseTitle: 'Maternal grandparents', ...ANA }

export const busySummary = (): StudioSummary => ({
  today: '2026-10-28',
  counts: {
    activeClients: 3,
    openCases: 4,
    casesByState: { intake: 1, active: 2, waiting: 1, delivered: 1, closed: 0 },
    overdueTasks: 2,
    tasksDueSoon: 3
  },
  continueCase: { ...CASE_A, state: 'active', dueDate: '2026-11-15' },
  activeCases: [{ ...CASE_A, state: 'active', dueDate: '2026-11-15' }],
  upcomingTasks: [
    { ...CASE_A, taskId: 'dddddddd-0000-4000-8000-000000000001', title: 'Request the 1931 register', dueDate: '2026-10-25', overdue: true },
    { ...CASE_A, taskId: 'dddddddd-0000-4000-8000-000000000002', title: 'Write the interim summary', dueDate: '2026-10-30', overdue: false }
  ],
  recentActivity: [
    { ...CASE_A, id: 'journal:1', kind: 'journal', at: '2026-10-27T15:00:00.000Z', label: 'Journal entry' },
    { ...CASE_A, id: 'time:1', kind: 'time', at: '2026-10-27T14:00:00.000Z', label: 'Logged 1h 30m' }
  ],
  hours: { weekMinutes: 330, monthMinutes: 900 }
})
