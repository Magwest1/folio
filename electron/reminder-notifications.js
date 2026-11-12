import { resolveSnoozePhrase } from '../server/reminders/snooze-phrase.js'
import { setTodoCheckbox } from '../server/actions/todo-sync.js'

const BUTTONS = ['Done', 'Snooze', 'Not important']

// Shows reminders as native notifications and routes their buttons. Kept apart from main.js so it can be tested with a
// fake Notification. Anything that goes wrong fails quietly: the in-app reminders on Home still work.
export function createReminderNotifier({ Notification, platform = process.platform, focusAction, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = () => new Date() }) {
  const live = new Set()
  let failed = false

  const supported = () => {
    try { return Boolean(Notification?.isSupported?.()) } catch { return false }
  }

  // Tells the renderer whether it should stay quiet because the system is showing reminders.
  const delivers = () => supported() && !failed

  async function perform(runtime, name, id) {
    const store = runtime.actionStore
    if (name === 'done') {
      const action = store.complete(id)
      if (action.origin === 'todo-list') await setTodoCheckbox(runtime, store.get(id), true).catch(() => {})
    } else if (name === 'snooze') {
      store.snooze(id, resolveSnoozePhrase('tomorrow morning', { now: now(), timeZone }).toISOString())
    } else {
      // Not important: one click, permanent, no follow-up question.
      store.letGo(id)
    }
  }

  function handle(reminder, runtime) {
    if (!delivers() || reminder.level === 'off') return false
    const single = reminder.kind === 'action' && reminder.actionIds.length === 1
    let notification
    try {
      notification = new Notification({
        title: reminder.title, body: reminder.body || '', silent: reminder.level === 'gentle',
        ...(platform === 'darwin' && single ? { actions: BUTTONS.map((text) => ({ type: 'button', text })) } : {}),
      })
    } catch { return false }
    live.add(notification)
    const release = () => live.delete(notification)
    // Once the system has it, the in-app path must not show it again.
    notification.on('show', () => { try { runtime.reminders.ack(reminder.id) } catch { /* the in-app copy stays */ } })
    notification.on('click', () => { release(); focusAction(single ? reminder.actionIds[0] : null) })
    notification.on('action', (_event, index) => {
      release()
      const name = ['done', 'snooze', 'not-important'][index]
      if (single && name) void perform(runtime, name, reminder.actionIds[0]).catch(() => {})
    })
    notification.on('close', release)
    notification.on('failed', () => { release(); failed = true })
    try { notification.show() } catch { release(); failed = true; return false }
    return true
  }

  return { handle, delivers, perform }
}
