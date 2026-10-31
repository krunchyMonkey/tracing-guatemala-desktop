import { Link, matchPath, useLocation } from 'react-router'
import { useOptionalDraftStore } from './DraftStoreContext'

// A small app-wide note while notebook pages (other than the one open on screen) still
// have text the host hasn't accepted. They keep trying in the background; this is the
// reminder to not close the window yet, with a way back to the first one.

export function UnsavedPagesIndicator() {
  const store = useOptionalDraftStore()
  const location = useLocation()
  if (!store) return null
  const open = matchPath('/cases/:caseId/notebook/:pageId', location.pathname)?.params.pageId
  const pending = store.unsavedPages().filter((draft) => draft.pageId !== open)
  if (pending.length === 0) return null
  const first = pending[0]!
  return (
    <p className="unsaved-pages" role="status">
      <Link to={`/cases/${first.caseId}/notebook/${first.pageId}`}>
        {pending.length} {pending.length === 1 ? 'page' : 'pages'} not saved yet
      </Link>
    </p>
  )
}
