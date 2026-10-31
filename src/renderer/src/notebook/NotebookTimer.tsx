import { ElapsedClock, useTimer } from '../cases/TimerContext'

// A compact research-hours control for the notebook header (#149). It only drives the
// existing timer (TimerContext): start, pause and resume here; stopping and saving the
// time goes through the same "Save this time?" dialog as everywhere else.

export function NotebookTimer({ caseId, caseTitle }: { caseId: string; caseTitle: string }) {
  const timer = useTimer()
  const own = timer.timer !== null && timer.timer.caseId === caseId ? timer.timer : null

  if (!own) {
    return (
      <div className="notebook-timer" role="group" aria-label="Research hours">
        <button type="button" className="button button-secondary button-small" disabled={timer.busy || !timer.loaded} onClick={() => timer.requestStart(caseId, caseTitle)}>
          Start timer
        </button>
      </div>
    )
  }
  const state = own.needsReview ? 'Needs review' : own.state === 'paused' ? 'Paused' : 'Running'
  return (
    <div className="notebook-timer" role="group" aria-label="Research hours">
      <ElapsedClock timer={own} syncedAt={timer.syncedAt} />
      <span className="muted">{state}</span>
      {own.needsReview ? (
        <button type="button" className="button button-secondary button-small" onClick={timer.reopenReview}>
          Review time
        </button>
      ) : (
        <>
          <button type="button" className="button button-secondary button-small" disabled={timer.busy} onClick={own.state === 'running' ? timer.pause : timer.resume}>
            {own.state === 'running' ? 'Pause timer' : 'Resume timer'}
          </button>
          <button type="button" className="button button-secondary button-small" disabled={timer.busy} onClick={timer.requestStop}>
            Stop &amp; save time
          </button>
        </>
      )}
    </div>
  )
}
