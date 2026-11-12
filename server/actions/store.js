import crypto from 'node:crypto'
import { fingerprintFor, quoteKey, textKey } from './fingerprint.js'
import { locateQuote } from './anchors.js'
import { createWriter, readState } from './persistence.js'
import {
  CLOSED_STATUSES, KINDS, asList, dueRange, httpError, normalizeDue, normalizeKind,
  normalizePerson, normalizeSnooze, normalizeSource, normalizeText,
} from './validate.js'

export { fadeStale } from './fade.js'
export { KINDS, STATUSES, CLOSED_STATUSES } from './validate.js'

const FEEDBACK_LIMIT = 2000
const TEXT_BLOCKING = ['let-go', 'rejected']
const DISMISSING = ['done', 'let-go', 'rejected']
const FEEDBACK_BY_STATUS = { done: 'completed', 'let-go': 'not-important', rejected: 'not-an-action' }
const clone = (value) => structuredClone(value)

export function createActionStore({ filePath, now = () => new Date(), idFactory = () => `act_${crypto.randomBytes(8).toString('hex')}` }) {
  let state = null
  const data = () => (state ||= readState(filePath, now))
  const writer = createWriter(filePath, data)
  const persist = () => writer.save()
  const stamp = (at) => (at ?? now()).toISOString()
  const inScope = (scope, id) => (scope.endsWith('/') ? id.startsWith(scope) : id === scope)

  function present(action) {
    const view = clone(action)
    if (view.status === 'snoozed' && view.snoozedUntil && Date.parse(view.snoozedUntil) <= now().getTime()) {
      view.status = 'open'
      view.snoozedUntil = null
    }
    return view
  }

  function require(id) {
    const action = data().actions.find((item) => item.id === id)
    if (!action) throw httpError(404, 'Action not found.')
    return action
  }

  function record(type, action) {
    const { feedback } = data()
    feedback.push({
      at: stamp(), actionId: action.id, type, text: action.text, quote: action.anchor?.quote || '',
      kind: action.kind, noteId: action.anchor?.noteId || null,
    })
    if (feedback.length > FEEDBACK_LIMIT) feedback.splice(0, feedback.length - FEEDBACK_LIMIT)
  }

  function move(action, to, { by = 'user', at } = {}) {
    const entry = { at: stamp(at), from: action.status, to, by }
    if (action.status === 'snoozed') entry.snoozedUntil = action.snoozedUntil
    action.history.push(entry)
    action.status = to
    if (to !== 'snoozed') action.snoozedUntil = null
    action.updatedAt = entry.at
    if (by === 'user') action.touchedAt = entry.at
  }

  function build(fields) {
    const at = stamp()
    const action = {
      id: idFactory(), text: '', kind: 'task', person: null, due: null, status: 'open', snoozedUntil: null,
      confidence: null, explicit: false, origin: 'manual', editedByUser: false, anchor: null,
      signals: [], promptVersion: null, modelId: null, createdAt: at, updatedAt: at, touchedAt: at, history: [],
      ...fields,
    }
    action.fingerprint = fingerprintFor({ quote: action.anchor?.quote, text: action.text })
    data().actions.push(action)
    return action
  }

  const matchesQuote = (action, noteId, key) => Boolean(key) && action.anchor?.noteId === noteId
    && (action.fingerprint.quoteKey === key || quoteKey(action.anchor.quote) === key)
  const matchesText = (action, key) => Boolean(key) && (action.fingerprint.textKey === key || action.fingerprint.editedTextKey === key)

  function suppressedBy(statuses, { noteId, quote, text, kind }) {
    const { suppressions, actions } = data()
    if (kind && suppressions.kinds.includes(kind)) return true
    if (noteId && suppressions.sources.some((source) => inScope(source, noteId))) return true
    const qk = quoteKey(quote)
    const tk = textKey(text)
    // done and faded block only the same passage in the same note, so recurring tasks can come back elsewhere.
    return actions.some((action) => statuses.includes(action.status)
      && (matchesQuote(action, noteId, qk) || (TEXT_BLOCKING.includes(action.status) && matchesText(action, tk))))
  }

  function applyExtraction(action, item, noteId, noteVersion) {
    if (!action.editedByUser) {
      action.text = item.text
      action.kind = item.kind
      action.person = item.person
      action.due = item.due
    }
    action.confidence = item.confidence ?? action.confidence
    action.explicit = action.explicit || item.explicit
    action.signals = [...new Set([...action.signals, ...item.signals])]
    action.promptVersion = item.promptVersion ?? action.promptVersion
    action.modelId = item.modelId ?? action.modelId
    if (item.anchor) action.anchor = { noteId, version: noteVersion ?? action.anchor?.version ?? null, ...item.anchor, orphaned: false }
    action.updatedAt = stamp()
    if (action.status === 'suggested' && item.status === 'open') move(action, 'open', { by: 'system' })
  }

  function cleanItem(item) {
    let due = null
    try { due = normalizeDue(item?.due) } catch { due = null }
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
    if (!text) return null
    const origin = item.origin === 'suggested' ? 'suggested' : 'auto'
    const anchor = item.anchor && Number.isInteger(item.anchor.from) && Number.isInteger(item.anchor.to)
      ? { from: item.anchor.from, to: item.anchor.to, quote: String(item.anchor.quote ?? '') } : null
    return {
      text, due, anchor, origin, signals: Array.isArray(item.signals) ? item.signals.map(String) : [],
      kind: KINDS.includes(item.kind) ? item.kind : 'task',
      person: (() => { try { return normalizePerson(item.person) } catch { return null } })(),
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
      explicit: item.explicit === true,
      status: item.status === 'open' || item.status === 'suggested' ? item.status : (origin === 'suggested' ? 'suggested' : 'open'),
      promptVersion: item.promptVersion ?? null, modelId: item.modelId ?? null,
    }
  }

  const store = {
    async load() { data() },
    flush: () => writer.flush(),

    list(filter = {}) {
      const statuses = asList(filter.status)
      const kinds = asList(filter.kind)
      const person = typeof filter.person === 'string' && filter.person ? filter.person.toLowerCase() : null
      const { dueFrom, dueTo } = filter
      const includeClosed = filter.includeClosed === true || filter.includeClosed === 'true' || filter.includeClosed === '1'
      return data().actions.map(present).filter((action) => {
        if (statuses ? !statuses.includes(action.status) : !includeClosed && CLOSED_STATUSES.includes(action.status)) return false
        if (kinds && !kinds.includes(action.kind)) return false
        if (filter.noteId && action.anchor?.noteId !== filter.noteId) return false
        if (person && action.person?.toLowerCase() !== person) return false
        if (dueFrom || dueTo) {
          const range = dueRange(action.due)
          if (!range || (dueFrom && range.end < dueFrom) || (dueTo && range.start > dueTo)) return false
        }
        return true
      }).sort((a, b) => {
        const left = dueRange(a.due)?.start
        const right = dueRange(b.due)?.start
        if (left !== right) return !left ? 1 : !right ? -1 : left < right ? -1 : 1
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
      })
    },

    get: (id) => { const action = data().actions.find((item) => item.id === id); return action ? present(action) : null },

    addFromExtraction(noteId, items, { noteVersion = null } = {}) {
      const result = { added: [], updated: [], suppressed: [] }
      for (const raw of Array.isArray(items) ? items : []) {
        const item = cleanItem(raw)
        if (!item) continue
        const quote = item.anchor?.quote || ''
        const fingerprint = fingerprintFor({ quote, text: item.text })
        const probe = { noteId, quote, text: item.text, kind: item.kind }
        // Faded actions also block re-adding, so a quietly faded item never comes back on its own.
        if (suppressedBy([...DISMISSING, 'faded'], probe)) { result.suppressed.push(raw); continue }
        const existing = data().actions.find((action) => !CLOSED_STATUSES.includes(action.status)
          && (matchesQuote(action, noteId, fingerprint.quoteKey) || (action.anchor?.noteId === noteId && matchesText(action, fingerprint.textKey))))
        if (existing) { applyExtraction(existing, item, noteId, noteVersion); result.updated.push(present(existing)); continue }
        const action = build({
          ...item, anchor: item.anchor && { noteId, version: noteVersion, ...item.anchor, orphaned: false },
        })
        if (action.status === 'suggested' && action.origin !== 'suggested') action.origin = 'suggested'
        result.added.push(present(action))
      }
      if (result.added.length || result.updated.length) persist()
      return result
    },

    addManual({ text, kind = 'task', due = null, person = null, noteId = null } = {}) {
      if (noteId !== null && typeof noteId !== 'string') throw httpError(400, 'noteId must be a string.')
      const action = build({
        text: normalizeText(text), kind: normalizeKind(kind), due: normalizeDue(due), person: normalizePerson(person),
        explicit: true, origin: 'manual',
        anchor: noteId ? { noteId, version: null, from: 0, to: 0, quote: '', orphaned: false } : null,
      })
      persist()
      return present(action)
    },

    // Checkbox lines of /todo-list.md. The user wrote them, so suppression never applies.
    addTodoLine({ text, anchor, checked = false }) {
      const action = build({
        text: normalizeText(text), explicit: true, origin: 'todo-list', status: checked ? 'done' : 'open',
        anchor: { version: null, orphaned: false, ...anchor },
      })
      persist()
      return present(action)
    },

    update(id, patch = {}) {
      const action = require(id)
      const next = {}
      if ('text' in patch) next.text = normalizeText(patch.text)
      if ('kind' in patch) next.kind = normalizeKind(patch.kind)
      if ('person' in patch) next.person = normalizePerson(patch.person)
      if ('due' in patch) next.due = normalizeDue(patch.due)
      if (!Object.keys(next).length) throw httpError(400, 'Nothing to update. Edit text, kind, person or due.')
      Object.assign(action, next, { editedByUser: true, updatedAt: stamp(), touchedAt: stamp() })
      if (next.text) action.fingerprint.editedTextKey = textKey(next.text)
      record('edited', action)
      persist()
      return present(action)
    },

    confirm(id) {
      const action = require(id)
      if (action.status === 'open') return present(action)
      if (action.status !== 'suggested') throw httpError(409, 'Only suggested actions can be confirmed.')
      move(action, 'open')
      record('accepted', action)
      persist()
      return present(action)
    },

    complete(id) { return transition(id, 'done', 'completed') },
    letGo(id) { return transition(id, 'let-go', 'not-important') },
    reject(id) { return transition(id, 'rejected', 'not-an-action') },

    reopen(id) {
      const action = require(id)
      if (action.status !== 'open' || action.snoozedUntil) { move(action, 'open'); persist() }
      return present(action)
    },

    snooze(id, until) {
      const action = require(id)
      if (CLOSED_STATUSES.includes(action.status)) throw httpError(409, 'Reopen the action before snoozing it.')
      const snoozedUntil = normalizeSnooze(until)
      move(action, 'snoozed')
      action.snoozedUntil = snoozedUntil
      persist()
      return present(action)
    },

    undo(id) {
      const action = require(id)
      const last = action.history.at(-1)
      if (!last) throw httpError(409, 'Nothing to undo.')
      const type = FEEDBACK_BY_STATUS[last.to] || (last.to === 'open' && last.from === 'suggested' ? 'accepted' : null)
      const { feedback } = data()
      const index = type ? feedback.findLastIndex((entry) => entry.actionId === id && entry.type === type) : -1
      if (index !== -1) feedback.splice(index, 1)
      action.history.pop()
      action.status = last.from
      action.snoozedUntil = last.snoozedUntil ?? null
      action.updatedAt = stamp()
      action.touchedAt = action.updatedAt
      persist()
      return present(action)
    },

    // Used by todo-list sync to keep an anchor in step with its line.
    setAnchor(id, patch) {
      const action = require(id)
      action.anchor = { ...(action.anchor || { noteId: null, version: null }), ...patch }
      action.updatedAt = stamp()
      persist()
      return present(action)
    },

    markFaded(ids, at = now()) {
      const wanted = new Set(ids)
      let changed = false
      for (const action of data().actions) {
        if (!wanted.has(action.id) || action.status !== 'open') continue
        move(action, 'faded', { by: 'system', at })
        changed = true
      }
      if (changed) persist()
    },

    isSuppressed: (probe) => suppressedBy(DISMISSING, probe || {}),

    suppressSource(source) {
      const { sources } = data().suppressions
      if (!sources.includes(normalizeSource(source))) { sources.push(source); persist() }
      return store.suppressions()
    },
    unsuppressSource(source) {
      const suppressions = data().suppressions
      if (suppressions.sources.includes(source)) { suppressions.sources = suppressions.sources.filter((item) => item !== source); persist() }
      return store.suppressions()
    },
    muteKind(kind) {
      const { kinds } = data().suppressions
      if (!kinds.includes(normalizeKind(kind))) { kinds.push(kind); persist() }
      return store.suppressions()
    },
    unmuteKind(kind) {
      const suppressions = data().suppressions
      if (suppressions.kinds.includes(kind)) { suppressions.kinds = suppressions.kinds.filter((item) => item !== kind); persist() }
      return store.suppressions()
    },
    suppressions: () => clone(data().suppressions),
    feedbackLog: () => clone(data().feedback),

    reanchor(noteId, content, { noteVersion = null } = {}) {
      const result = { moved: [], orphaned: [] }
      let changed = false
      for (const action of data().actions) {
        const anchor = action.anchor
        if (anchor?.noteId !== noteId || !anchor.quote) continue
        const hit = locateQuote(String(content ?? ''), anchor)
        if (!hit) {
          if (!anchor.orphaned) { anchor.orphaned = true; changed = true }
          result.orphaned.push(action.id)
          continue
        }
        if (hit.from !== anchor.from || hit.to !== anchor.to || hit.quote !== anchor.quote || anchor.orphaned) result.moved.push(action.id)
        if (anchor.orphaned || hit.from !== anchor.from || hit.to !== anchor.to || hit.quote !== anchor.quote
          || (noteVersion !== null && anchor.version !== noteVersion)) changed = true
        Object.assign(anchor, hit, { orphaned: false, version: noteVersion ?? anchor.version })
      }
      if (changed) persist()
      return result
    },

    moveNote(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return Promise.resolve()
      const folder = oldId.endsWith('/') && newId.endsWith('/')
      const rewrite = (id) => (folder ? (id.startsWith(oldId) ? newId + id.slice(oldId.length) : id) : (id === oldId ? newId : id))
      const current = data()
      let changed = false
      for (const { anchor } of current.actions) {
        if (!anchor?.noteId || rewrite(anchor.noteId) === anchor.noteId) continue
        anchor.noteId = rewrite(anchor.noteId)
        changed = true
      }
      const sources = current.suppressions.sources.map(rewrite)
      if (sources.some((source, index) => source !== current.suppressions.sources[index])) { current.suppressions.sources = [...new Set(sources)]; changed = true }
      for (const id of Object.keys(current.noteStates)) {
        if (rewrite(id) === id) continue
        current.noteStates[rewrite(id)] = current.noteStates[id]
        delete current.noteStates[id]
        changed = true
      }
      return changed ? persist() : Promise.resolve()
    },

    forget(scope) {
      if (!scope) return Promise.resolve()
      const current = data()
      let changed = false
      for (const action of current.actions) {
        if (!action.anchor || !inScope(scope, action.anchor.noteId) || CLOSED_STATUSES.includes(action.status) || action.anchor.orphaned) continue
        action.anchor.orphaned = true
        changed = true
      }
      const sources = current.suppressions.sources.filter((source) => !inScope(scope, source))
      if (sources.length !== current.suppressions.sources.length) { current.suppressions.sources = sources; changed = true }
      for (const id of Object.keys(current.noteStates)) if (inScope(scope, id)) { delete current.noteStates[id]; changed = true }
      return changed ? persist() : Promise.resolve()
    },

    noteState: (noteId) => clone(data().noteStates[noteId] || null),
    setNoteState(noteId, noteState) {
      const { contentHash = null, promptVersion = null, processedAt = stamp() } = noteState || {}
      data().noteStates[noteId] = { contentHash, promptVersion, processedAt }
      return persist()
    },
  }

  function transition(id, to, feedbackType) {
    const action = require(id)
    if (action.status === to) return present(action)
    move(action, to)
    record(feedbackType, action)
    persist()
    return present(action)
  }

  return store
}
