import { Link } from 'react-router'
import { backupIsDue, daysSince, useBackupStatus } from '../runtime/useBackupStatus'

// A gentle, non-modal reminder on the Live Home screen (#117): shown only when
// the host reports no backup or one older than a week. Never in the demo or the
// desktop app (they have no backup status), and not while the status is unknown.
export function BackupReminder() {
  const { status } = useBackupStatus()
  if (!status || !backupIsDue(status)) return null
  return (
    <div className="alert alert-warning" role="note" aria-label="Backup reminder">
      <p className="alert-title">Time to back up</p>
      <p>
        {status.lastBackupAt
          ? `Your last backup was ${daysSince(status.lastBackupAt)} days ago.`
          : 'You haven’t made a backup yet.'}{' '}
        <Link to="/settings">Open Settings &amp; Backup</Link> to make one.
      </p>
    </div>
  )
}
