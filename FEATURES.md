# Future Features

## Tasks

- **Subtasks** — nest tasks under a parent task with their own done/priority state
- **Recurring tasks** — daily/weekly/monthly recurrence rules; auto-spawn a copy when marked done
- **Bulk edit** — change priority or tags on multiple selected tasks at once (selection bar already exists)
- **Drag-to-reorder** — manual sort order persisted alongside git sync
- **Due-date reminders** — native OS notification (Tauri `notification` plugin) when a task is due or overdue
- **Estimated time** — add an `estimate` field (e.g. `~2h`) alongside logged work sessions
- **Keyboard-only task creation** — press `n` anywhere to open the new-task form without clicking the FAB

## Docs / Notes

- **Folder tree sidebar** — show the `folder` field as a collapsible tree instead of a flat list
- **Full markdown preview** — toggle between raw edit and rendered preview (already have content field)
- **Note linking** — `[[note title]]` wikilink syntax that opens the linked note
- **Note templates** — a set of starter templates (meeting notes, project brief, etc.)

## Time Tracking

- **Daily/weekly report** — aggregate work sessions per day or week with a bar chart
- **Pomodoro mode** — 25-min countdown timer with automatic break prompt
- **Export to CSV** — dump work sessions to a CSV file for import into spreadsheets
- Function for deleting tracked time windows if misclicked.

## Search

- **Search by date range** — filter tasks or notes updated/created between two dates

## Sync & Data

- **Conflict resolution UI** — when a git merge conflict occurs, show a diff and let the user pick a side
- **Backup/export** — one-click export of all data as a zip archive into email or so
- **Import from other apps** — parse Todoist/Things CSV or Markdown task lists on import
- **Performance** — UI slows down whenever syncing with repo. Fix that

## UI / UX

- **Themes** — light mode + a few accent-color presets (currently hard-coded dark indigo)
- **Command palette** — `Cmd+K` fuzzy-search over all actions and notes
- **Compact / comfortable density toggle** — collapse task meta row for very long lists
- **Quick-capture from tray** — system-tray icon that opens a mini input window without focusing the main app
