import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { checkNotebookTitle, PAGE_TITLE_MAX, SECTION_TITLE_MAX } from '../../../shared/notebook'
import { activePages, activeSections, archivedEntries, NEW_SECTION_TITLE, type OutlineSection } from './notebookModel'

// The "Notebook" list: sections as collapsible groups with their pages, an options menu
// per section and page, and an "Archived" disclosure to restore things. It only reports
// what the person asked for; the notebook screen talks to the host and refreshes.

export interface NavActions {
  createSection(title: string): void
  renameSection(sectionId: string, title: string): void
  moveSection(sectionId: string, direction: -1 | 1): void
  archiveSection(sectionId: string): void
  unarchiveSection(sectionId: string): void
  createPage(sectionId: string): void
  renamePage(pageId: string, title: string): void
  movePage(pageId: string, direction: -1 | 1): void
  movePageToSection(pageId: string, sectionId: string): void
  archivePage(pageId: string): void
  unarchivePage(pageId: string): void
}

interface NotebookNavProps {
  id: string
  caseId: string
  sections: OutlineSection[]
  currentPageId: string | undefined
  /** Case or client archived: the list only navigates. */
  readOnly: boolean
  actions: NavActions
  /** A page or section was chosen (the narrow layout closes the list). */
  onNavigate(): void
}

type Renaming = { kind: 'section' | 'page'; id: string } | null

const pageHref = (caseId: string, pageId: string): string => `/cases/${caseId}/notebook/${pageId}`

export function NotebookNav({ id, caseId, sections, currentPageId, readOnly, actions, onNavigate }: NotebookNavProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<Renaming>(null)
  const [addingSection, setAddingSection] = useState(false)
  const active = activeSections(sections)
  const archived = archivedEntries(sections)

  const toggle = (sectionId: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(sectionId)) next.add(sectionId)
      return next
    })

  return (
    <nav id={id} className="note-nav" aria-label="Notebook">
      <h2 className="note-nav-heading">Notebook</h2>

      {active.length === 0 && <p className="muted note-nav-empty">No sections yet.</p>}
      <ul className="note-nav-sections">
        {active.map((section, index) => {
          const open = !collapsed.has(section.id)
          const pages = activePages(section)
          const panelId = `${id}-section-${section.id}`
          return (
            <li key={section.id} className="note-nav-section">
              <div className="note-nav-row">
                {renaming?.kind === 'section' && renaming.id === section.id ? (
                  <InlineName
                    label="Section name"
                    initial={section.title}
                    max={SECTION_TITLE_MAX}
                    onSave={(title) => {
                      setRenaming(null)
                      if (title !== section.title) actions.renameSection(section.id, title)
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button type="button" className="note-nav-section-button" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(section.id)}>
                    <span className="note-nav-chevron" aria-hidden="true" />
                    <span className="note-nav-section-title">{section.title}</span>
                    <span className="muted note-nav-count">
                      <span className="visually-hidden">, </span>
                      {pages.length}
                      <span className="visually-hidden"> {pages.length === 1 ? 'page' : 'pages'}</span>
                    </span>
                  </button>
                )}
                {!readOnly && (
                  <OptionsMenu label={`Options for section ${section.title}`}>
                    {(close) => (
                      <>
                        <MenuButton onClick={() => close(() => actions.createPage(section.id))}>Add a page</MenuButton>
                        <MenuButton onClick={() => close(() => setRenaming({ kind: 'section', id: section.id }))}>Rename</MenuButton>
                        <MenuButton disabled={index === 0} onClick={() => close(() => actions.moveSection(section.id, -1))}>
                          Move up
                        </MenuButton>
                        <MenuButton disabled={index === active.length - 1} onClick={() => close(() => actions.moveSection(section.id, 1))}>
                          Move down
                        </MenuButton>
                        <MenuButton onClick={() => close(() => actions.archiveSection(section.id))}>Archive section</MenuButton>
                      </>
                    )}
                  </OptionsMenu>
                )}
              </div>

              <div id={panelId} hidden={!open}>
                {pages.length === 0 ? (
                  <p className="muted note-nav-empty">
                    No pages yet.{' '}
                    {!readOnly && (
                      <button type="button" className="link-button" onClick={() => actions.createPage(section.id)}>
                        Add a page
                      </button>
                    )}
                  </p>
                ) : (
                  <ul className="note-nav-pages">
                    {pages.map((page, pageIndex) => (
                      <li key={page.id} className="note-nav-row">
                        {renaming?.kind === 'page' && renaming.id === page.id ? (
                          <InlineName
                            label="Page title"
                            initial={page.title}
                            max={PAGE_TITLE_MAX}
                            onSave={(title) => {
                              setRenaming(null)
                              if (title !== page.title) actions.renamePage(page.id, title)
                            }}
                            onCancel={() => setRenaming(null)}
                          />
                        ) : (
                          <Link className="note-nav-page" to={pageHref(caseId, page.id)} aria-current={page.id === currentPageId ? 'page' : undefined} onClick={onNavigate}>
                            {page.title}
                          </Link>
                        )}
                        {!readOnly && (
                          <OptionsMenu label={`Options for page ${page.title}`}>
                            {(close) => (
                              <>
                                <MenuButton onClick={() => close(() => setRenaming({ kind: 'page', id: page.id }))}>Rename</MenuButton>
                                <MenuButton disabled={pageIndex === 0} onClick={() => close(() => actions.movePage(page.id, -1))}>
                                  Move up
                                </MenuButton>
                                <MenuButton disabled={pageIndex === pages.length - 1} onClick={() => close(() => actions.movePage(page.id, 1))}>
                                  Move down
                                </MenuButton>
                                {active.length > 1 && (
                                  <label className="note-menu-select">
                                    <span>Move to section</span>
                                    <select
                                      value=""
                                      onChange={(event) => {
                                        const target = event.target.value
                                        if (target) close(() => actions.movePageToSection(page.id, target))
                                      }}
                                    >
                                      <option value="">Choose…</option>
                                      {active
                                        .filter((s) => s.id !== section.id)
                                        .map((s) => (
                                          <option key={s.id} value={s.id}>
                                            {s.title}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                )}
                                <MenuButton onClick={() => close(() => actions.archivePage(page.id))}>Archive page</MenuButton>
                              </>
                            )}
                          </OptionsMenu>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!readOnly && pages.length > 0 && (
                  <button type="button" className="note-nav-add" onClick={() => actions.createPage(section.id)}>
                    + Add a page
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {!readOnly &&
        (addingSection ? (
          <InlineName
            label="New section name"
            initial={NEW_SECTION_TITLE}
            max={SECTION_TITLE_MAX}
            submitLabel="Add section"
            onSave={(title) => {
              setAddingSection(false)
              actions.createSection(title)
            }}
            onCancel={() => setAddingSection(false)}
          />
        ) : (
          <button type="button" className="note-nav-add note-nav-add-section" onClick={() => setAddingSection(true)}>
            + New section
          </button>
        ))}

      {archived.length > 0 && (
        <details className="note-nav-archived">
          <summary>Archived ({archived.length})</summary>
          <ul className="note-nav-archived-list">
            {archived.map(({ section, sectionArchived, pages }) => (
              <li key={section.id}>
                {sectionArchived && (
                  <div className="note-nav-row note-nav-archived-row">
                    <span className="note-nav-archived-title">
                      {section.title} <span className="muted">(section)</span>
                    </span>
                    {!readOnly && (
                      <button type="button" className="button button-ghost button-small" aria-label={`Restore section ${section.title}`} onClick={() => actions.unarchiveSection(section.id)}>
                        Restore
                      </button>
                    )}
                  </div>
                )}
                <ul className="note-nav-pages">
                  {pages.map((page) => (
                    <li key={page.id} className="note-nav-row note-nav-archived-row">
                      <Link className="note-nav-page" to={pageHref(caseId, page.id)} aria-current={page.id === currentPageId ? 'page' : undefined} onClick={onNavigate}>
                        {page.title}
                        {!sectionArchived && <span className="muted"> · {section.title}</span>}
                      </Link>
                      {!readOnly && !sectionArchived && (
                        <button type="button" className="button button-ghost button-small" aria-label={`Restore page ${page.title}`} onClick={() => actions.unarchivePage(page.id)}>
                          Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  )
}

function MenuButton({ children, onClick, disabled = false }: { children: ReactNode; onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" className="note-menu-item" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

/** A "…" button that opens a short list of actions; Escape and a click elsewhere close it. */
function OptionsMenu({ label, children }: { label: string; children: (close: (then?: () => void) => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  const close = (then?: () => void) => {
    setOpen(false)
    then?.()
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
  }

  return (
    <div ref={rootRef} className="note-menu" onKeyDown={onKeyDown}>
      <button ref={buttonRef} type="button" className="note-menu-button" aria-label={label} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div id={panelId} className="note-menu-panel" role="group" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  )
}

/** A name field that saves on Enter or the button and cancels on Escape. */
function InlineName({ label, initial, max, submitLabel = 'Save', onSave, onCancel }: { label: string; initial: string; max: number; submitLabel?: string; onSave(title: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial)
  const [issue, setIssue] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const check = checkNotebookTitle(value, max)
    if (check.title === null) {
      setIssue(check.issues[0]?.code === 'too-long' ? `Keep it under ${max} characters.` : check.issues[0]?.code === 'required' ? 'Enter a name.' : 'Remove the special characters.')
      return
    }
    onSave(check.title)
  }

  return (
    <form className="note-inline-name" onSubmit={submit} onKeyDown={(event) => event.key === 'Escape' && onCancel()}>
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <input id={inputId} ref={inputRef} type="text" value={value} aria-invalid={issue ? true : undefined} onChange={(event) => {
        setValue(event.target.value)
        setIssue(null)
      }} />
      <button type="submit" className="button button-secondary button-small">
        {submitLabel}
      </button>
      <button type="button" className="button button-ghost button-small" onClick={onCancel}>
        Cancel
      </button>
      {issue && (
        <p className="issue-error note-inline-issue" role="alert">
          {issue}
        </p>
      )}
    </form>
  )
}
