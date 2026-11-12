import { KINDS, STATUSES, asList, httpError, normalizeKind, normalizeSource } from '../actions/validate.js'
import { setTodoCheckbox, syncTodoListFromDisk } from '../actions/todo-sync.js'
import { resolveSnoozePhrase } from '../reminders/snooze-phrase.js'

const TRANSITIONS = {
  confirm: (store, id) => store.confirm(id),
  complete: (store, id) => store.complete(id),
  reopen: (store, id) => store.reopen(id),
  // Either an explicit time or a phrase in plain words ("tomorrow after lunch") read in the user's time zone.
  snooze: (store, id, body) => store.snooze(id, body?.phrase !== undefined
    ? resolveSnoozePhrase(body.phrase, { now: new Date(), timeZone: body.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone }).toISOString()
    : body?.until ?? body?.snoozedUntil),
  keep: (store, id) => store.touch(id),
  'let-go': (store, id) => store.letGo(id),
  reject: (store, id) => store.reject(id),
  undo: (store, id) => store.undo(id),
  // "Looks done?" answers. Undoing a system change (auto-completion, merged repeat) goes through /undo.
  'completion/accept': (store, id) => store.acceptCompletion(id),
  'completion/dismiss': (store, id) => store.dismissCompletion(id),
}
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function registerRoutes(app, runtime) {
  function fail(response, next, error) {
    if (error.status) return response.status(error.status).json({ error: error.message })
    return next(error)
  }

  async function readyStore() {
    const store = runtime.actionStore
    await store.load()
    return store
  }

  async function syncTodoQuietly() {
    try { await syncTodoListFromDisk(runtime) } catch (error) {
      console.error(`Could not sync the todo list with actions. ${error.message}`)
    }
  }

  function filterFromQuery(query) {
    const filter = {}
    const statuses = asList(query.status)
    const kinds = asList(query.kind)
    if (statuses) {
      if (statuses.some((status) => !STATUSES.includes(status))) throw httpError(400, `Status must be one of ${STATUSES.join(', ')}.`)
      filter.status = statuses
    }
    if (kinds) {
      if (kinds.some((kind) => !KINDS.includes(kind))) throw httpError(400, `Kind must be one of ${KINDS.join(', ')}.`)
      filter.kind = kinds
    }
    for (const key of ['dueFrom', 'dueTo']) {
      if (query[key] === undefined || query[key] === '') continue
      if (typeof query[key] !== 'string' || !DATE.test(query[key])) throw httpError(400, `${key} must be YYYY-MM-DD.`)
      filter[key] = query[key]
    }
    if (typeof query.noteId === 'string' && query.noteId) filter.noteId = query.noteId
    if (typeof query.person === 'string' && query.person) filter.person = query.person
    filter.includeClosed = ['true', '1'].includes(String(query.includeClosed))
    return filter
  }

  function suppressionTarget(request) {
    const source = request.body?.source ?? request.query.source
    const kind = request.body?.kind ?? request.query.kind
    if ((source === undefined) === (kind === undefined)) throw httpError(400, 'Send exactly one of source or kind.')
    return source !== undefined ? { source: normalizeSource(source) } : { kind: normalizeKind(kind) }
  }

  app.get('/api/actions', async (request, response, next) => {
    try {
      const filter = filterFromQuery(request.query)
      const store = await readyStore()
      await syncTodoQuietly()
      response.json(store.list(filter))
    } catch (error) { fail(response, next, error) }
  })

  // Registered before /:id so "suppressions" is never read as an action id.
  app.get('/api/actions/suppressions', async (_request, response, next) => {
    try { response.json((await readyStore()).suppressions()) } catch (error) { fail(response, next, error) }
  })

  app.post('/api/actions/suppressions', async (request, response, next) => {
    try {
      const target = suppressionTarget(request)
      const store = await readyStore()
      response.status(201).json('source' in target ? store.suppressSource(target.source) : store.muteKind(target.kind))
    } catch (error) { fail(response, next, error) }
  })

  app.delete('/api/actions/suppressions', async (request, response, next) => {
    try {
      const target = suppressionTarget(request)
      const store = await readyStore()
      response.json('source' in target ? store.unsuppressSource(target.source) : store.unmuteKind(target.kind))
    } catch (error) { fail(response, next, error) }
  })

  app.get('/api/actions/:id', async (request, response, next) => {
    try {
      const action = (await readyStore()).get(request.params.id)
      if (!action) return response.status(404).json({ error: 'Action not found.' })
      response.json(action)
    } catch (error) { fail(response, next, error) }
  })

  app.post('/api/actions', async (request, response, next) => {
    try {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Send a JSON object.')
      const store = await readyStore()
      response.status(201).json(store.addManual({
        text: body.text, kind: body.kind ?? 'task', due: body.due ?? null, person: body.person ?? null, noteId: body.noteId ?? null,
      }))
    } catch (error) { fail(response, next, error) }
  })

  app.patch('/api/actions/:id', async (request, response, next) => {
    try {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Send a JSON object.')
      const store = await readyStore()
      response.json(store.update(request.params.id, body))
    } catch (error) { fail(response, next, error) }
  })

  for (const [name, apply] of Object.entries(TRANSITIONS)) {
    app.post(`/api/actions/:id/${name}`, async (request, response, next) => {
      try {
        const store = await readyStore()
        const before = store.get(request.params.id)
        if (!before) return response.status(404).json({ error: 'Action not found.' })
        const touchesTodoList = before.origin === 'todo-list' && ['complete', 'reopen', 'undo'].includes(name)
        // Bring the anchor up to date with the file first, so the checkbox flip lands on the right line.
        if (touchesTodoList) await syncTodoQuietly()
        const action = apply(store, request.params.id, request.body)
        if (touchesTodoList) {
          try { await setTodoCheckbox(runtime, store.get(action.id), action.status === 'done') } catch (error) {
            console.error(`Could not update the todo list checkbox. ${error.message}`)
          }
        }
        const view = store.get(action.id)
        response.json(name === 'snooze' ? { ...view, until: view.snoozedUntil } : view)
      } catch (error) { fail(response, next, error) }
    })
  }
}
