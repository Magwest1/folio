// Per-bundle reminder service: one timer set to the planner's next wake-up (never polling), re-planned when the
// action store changes, when settings change and when the machine wakes. Emits `reminder` events; the Electron shell
// shows them natively and the web build serves them from /api/reminders/pending. Fired reminders wait there until acked.
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fadeUnanswered } from '../actions/fade.js'
import { planReminders } from './planner.js'
import { createReminderState } from './settings.js'
import { localParts } from './time.js'

const MIN_DELAY_MS = 1_000
const MAX_DELAY_MS = 15 * 60_000
const CHANGE_DEBOUNCE_MS = 150

export function createReminderService(runtime, options = {}) {
  const settings = {
    now: () => new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...runtime.reminderOptions, ...options,
  }
  const state = createReminderState(options.filePath || path.join(runtime.bundleRoot, '.folio', 'reminders.json'), { now: settings.now })
  const events = new EventEmitter()
  let timer = null
  let debounce = null
  let unsubscribe = null
  let started = false
  let closed = false
  let planning = false
  let lastFadeDay = null

  const store = () => runtime.actionStore
  const clear = () => { clearTimeout(timer); timer = null }

  function snapshot(at) {
    const suppressions = store().suppressions()
    return planReminders({
      actions: store().list({ includeClosed: false, rawSnooze: true }), settings: state.settings(), now: at,
      timeZone: settings.timeZone, ledger: state.ledger(), suppressions,
    })
  }

  // Check-ins are stamped the first time they are seen, so "at most one" survives restarts.
  function stampCheckins(plan, at) {
    const keys = plan.checkins.filter((item) => item.fresh).map((item) => item.key)
    if (keys.length) state.record(keys, at)
  }

  function replan() {
    if (closed || !started) return
    clear()
    clearTimeout(debounce)
    debounce = null
    const at = settings.now()
    planning = true
    let plan
    try {
      plan = snapshot(at)
      stampCheckins(plan, at)
      const day = localParts(at, settings.timeZone).date
      if (plan.fade.length && day !== lastFadeDay) {
        lastFadeDay = day
        fadeUnanswered(store(), plan.fade, { now: at })
      } else if (lastFadeDay === null) lastFadeDay = day
      if (plan.due.length || plan.silentKeys.length) {
        state.record([...plan.due.flatMap((reminder) => reminder.keys), ...plan.silentKeys], at)
        state.setPending([...state.pending(), ...plan.due])
        for (const reminder of plan.due) events.emit('reminder', reminder)
      }
    } catch (error) {
      console.error(`Could not plan reminders. ${error.message}`)
    } finally {
      planning = false
    }
    const wake = plan?.nextWakeAt ? plan.nextWakeAt.getTime() - settings.now().getTime() : MAX_DELAY_MS
    timer = setTimeout(replan, Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, wake)))
    timer.unref?.()
  }

  function changed() {
    if (planning || closed || !started) return
    clearTimeout(debounce)
    debounce = setTimeout(replan, CHANGE_DEBOUNCE_MS)
    debounce.unref?.()
  }

  // Reminders still waiting for a person: their action must still be open (a lapsed snooze counts as open).
  function pending() {
    const open = new Set(store().list({ status: ['open'] }).map((action) => action.id))
    const reminders = state.pending().filter((reminder) => !reminder.actionIds.length || reminder.actionIds.some((id) => open.has(id)))
    const plan = snapshot(settings.now())
    stampCheckins(plan, settings.now())
    return { reminders, checkins: plan.checkins.map(({ actionId, since }) => ({ actionId, since })) }
  }

  return {
    start() {
      if (started || closed) return
      started = true
      store().load()
      unsubscribe = store().onChange?.(changed) || null
      replan()
    },
    replan,
    onReminder(listener) {
      events.on('reminder', listener)
      return () => events.off('reminder', listener)
    },
    pending,
    ack(id) {
      const before = state.pending()
      const rest = before.filter((reminder) => reminder.id !== id)
      if (rest.length !== before.length) state.setPending(rest)
      return rest.length !== before.length
    },
    settings: () => state.settings(),
    updateSettings(patch) {
      const next = state.update(patch)
      replan()
      return next
    },
    async close() {
      closed = true
      clear()
      clearTimeout(debounce)
      unsubscribe?.()
      events.removeAllListeners()
      await state.flush()
    },
    flush: () => state.flush(),
  }
}
