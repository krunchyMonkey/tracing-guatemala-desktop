import { Link } from 'react-router'
import { ElapsedClock, useTimer } from '../cases/TimerContext'
import { Alert } from '../clients/components'

// The one visible research timer (#109): on every screen while a timer exists.
// The seconds are not announced; only state changes are (see TimerProvider).

export function TimerPill() {
  const { timer, syncedAt, caseTitle, busy, notice, dismissNotice, pause, resume, requestStop, reopenReview } = useTimer()
  if (!timer && !notice) return null
  const title = caseTitle ?? 'this case'
  const stateText = timer?.needsReview ? 'Needs review' : timer?.state === 'paused' ? 'Paused' : 'Running'

  return (
    <section className="timer-pill" aria-label="Research timer">
      {notice && (
        <div className="timer-notice">
          <Alert tone="warning">
            <p>{notice}</p>
            <button type="button" className="button button-small button-secondary" onClick={dismissNotice}>
              Dismiss
            </button>
          </Alert>
        </div>
      )}
      {timer && (
        <>
          <p className="timer-case">
            <Link to={`/cases/${timer.caseId}`} aria-label={`Go to the case being timed: ${title}`}>
              {title}
            </Link>
          </p>
          <p className="timer-readout">
            <ElapsedClock timer={timer} syncedAt={syncedAt} />
            <span className={`timer-state timer-state-${timer.needsReview ? 'review' : timer.state}`}>{stateText}</span>
          </p>
          <div className="timer-actions">
            {timer.needsReview ? (
              <button type="button" className="button button-small button-primary" onClick={reopenReview}>
                Review time
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-small button-secondary"
                  disabled={busy}
                  aria-label={`${timer.state === 'running' ? 'Pause' : 'Resume'} timer on ${title}`}
                  onClick={timer.state === 'running' ? pause : resume}
                >
                  {timer.state === 'running' ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="button button-small button-primary"
                  disabled={busy}
                  aria-label={`Stop and save timer on ${title}`}
                  onClick={requestStop}
                >
                  Stop &amp; Save
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
