import type {
  NotebookOutline,
  NotebookPage,
  NotebookPageResult,
  NotebookPageSaveResult,
  NotebookSectionResult,
  PageInput,
  PageMove,
  PageRevision,
  PageRevisionSummary,
  PageSave,
  SectionInput
} from '../../../shared/notebook'

/** Research notebook calls (#147); every call is scoped by the case id, which the host checks. */
export interface NotebookApi {
  /** The case's sections and pages, without page content; null for an unknown case. */
  getNotebook(caseId: string): Promise<NotebookOutline | null>
  createNotebookSection(caseId: string, input: SectionInput): Promise<NotebookSectionResult>
  renameNotebookSection(caseId: string, sectionId: string, input: SectionInput): Promise<NotebookSectionResult>
  moveNotebookSection(caseId: string, sectionId: string, toIndex: number): Promise<NotebookSectionResult>
  archiveNotebookSection(caseId: string, sectionId: string): Promise<NotebookSectionResult>
  unarchiveNotebookSection(caseId: string, sectionId: string): Promise<NotebookSectionResult>
  createNotebookPage(caseId: string, sectionId: string, input: PageInput): Promise<NotebookPageResult>
  getNotebookPage(caseId: string, pageId: string): Promise<NotebookPage | null>
  renameNotebookPage(caseId: string, pageId: string, input: PageInput): Promise<NotebookPageResult>
  moveNotebookPage(caseId: string, pageId: string, move: PageMove): Promise<NotebookPageResult>
  archiveNotebookPage(caseId: string, pageId: string): Promise<NotebookPageResult>
  unarchiveNotebookPage(caseId: string, pageId: string): Promise<NotebookPageResult>
  /** Refused with `conflict` and the current page when `baseVersion` is stale. */
  saveNotebookPage(caseId: string, pageId: string, save: PageSave): Promise<NotebookPageSaveResult>
  /** Newest first. */
  listPageRevisions(caseId: string, pageId: string): Promise<PageRevisionSummary[]>
  getPageRevision(caseId: string, pageId: string, revisionId: string): Promise<PageRevision | null>
  restorePageRevision(caseId: string, pageId: string, revisionId: string, baseVersion: number): Promise<NotebookPageSaveResult>
}
