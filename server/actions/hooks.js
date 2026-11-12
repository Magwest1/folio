import { TODO_LIST_ID, syncTodoListFromDisk } from './todo-sync.js'

// Fire-and-forget hooks for note saves. Failures are logged and never block the save.
export function reanchorNote(runtime, noteId, content) {
  const store = runtime.actionStore
  if (!store || typeof content !== 'string') return
  try {
    if (noteId === TODO_LIST_ID) {
      syncTodoListFromDisk(runtime).catch((error) => console.error(`Could not sync the todo list with actions. ${error.message}`))
      return
    }
    store.reanchor(noteId, content)
  } catch (error) {
    console.error(`Could not re-anchor actions for ${noteId}. ${error.message}`)
  }
}
