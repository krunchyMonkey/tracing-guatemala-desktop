import { TIME_MAX_MINUTES, TIME_NOTE_MAX, type ActivityType, type TimeIssue } from '../../../shared/case-time'

// Plain-language labels for the research hours (#109). Activity types are
// provisional until the researcher review (#21).

export const activityLabels: Record<ActivityType, string> = {
  research: 'Research',
  correspondence: 'Correspondence',
  analysis: 'Analysis',
  writing: 'Writing',
  other: 'Other'
}

export const timeIssueMessages: Record<TimeIssue['field'], Partial<Record<TimeIssue['code'], string>>> = {
  workDate: {
    required: 'Choose the date you worked.',
    'invalid-format': 'Choose a date.',
    'invalid-date': 'That date doesn’t exist. Choose a real date.'
  },
  durationMinutes: {
    'invalid-format': 'Use whole numbers for hours and minutes.',
    'too-short': 'Enter at least 1 minute.',
    'too-long': `Enter at most ${TIME_MAX_MINUTES / 60} hours per entry. Split longer work into separate entries.`
  },
  activityType: { 'invalid-value': 'Choose one of the listed activities, or leave it empty.' },
  note: {
    'too-long': `Keep the note under ${TIME_NOTE_MAX} characters.`,
    'invalid-characters': 'The note has a character that can’t be saved. Remove it and try again.'
  }
}
