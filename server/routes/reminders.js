import { httpError } from '../actions/validate.js'

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

  app.get('/api/reminders/settings', (_request, response, next) => {
    try { response.json(runtime.reminders.settings()) } catch (error) { fail(response, next, error) }
  })

  app.put('/api/reminders/settings', (request, response, next) => {
    try { response.json(runtime.reminders.updateSettings(request.body)) } catch (error) { fail(response, next, error) }
  })

  // Reminders that fired and nobody has seen yet, plus the quiet "still relevant?" prompts.
  app.get('/api/reminders/pending', async (_request, response, next) => {
    try {
      await readyStore()
      response.json(runtime.reminders.pending())
    } catch (error) { fail(response, next, error) }
  })

  app.post('/api/reminders/:id/ack', (request, response, next) => {
    try { response.json({ acked: runtime.reminders.ack(request.params.id) }) } catch (error) { fail(response, next, error) }
  })

  // "Clear everything from this note": one undoable batch. The ids come back so the client can undo it.
  app.post('/api/actions/clear-note', async (request, response, next) => {
    try {
      const noteId = request.body?.noteId
      if (typeof noteId !== 'string' || !noteId) throw httpError(400, 'Send the noteId to clear.')
      response.json({ ids: (await readyStore()).clearNote(noteId) })
    } catch (error) { fail(response, next, error) }
  })

  app.post('/api/actions/undo-batch', async (request, response, next) => {
    try {
      const ids = request.body?.ids
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw httpError(400, 'Send the ids to bring back.')
      response.json({ ids: (await readyStore()).undoMany(ids) })
    } catch (error) { fail(response, next, error) }
  })
}
