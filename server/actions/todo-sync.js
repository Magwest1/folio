import fs from 'node:fs/promises'
import { quoteKey } from './fingerprint.js'

export const TODO_LIST_ID = '/todo-list.md'

const CHECKBOX_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(\S.*)$/u
const FENCE = /^\s*(?:```|~~~)/u

// Checkbox lines only. Instructional prose, headings and fenced code are ignored.
export function parseTodoLines(content) {
  const lines = []
  let offset = 0
  let fenced = false
  for (const raw of String(content ?? '').split('\n')) {
    const lineStart = offset
    offset += raw.length + 1
    if (FENCE.test(raw)) { fenced = !fenced; continue }
    const match = !fenced && CHECKBOX_LINE.exec(raw.trimEnd())
    if (!match) continue
    const from = lineStart + match[1].length
    const quote = raw.trimEnd().slice(match[1].length)
    lines.push({ text: match[3].trim(), checked: match[2] !== ' ', from, to: from + quote.length, quote })
  }
  return lines
}

// Two-way sync, file to store. Lines are matched to actions by fingerprint; nothing is ever deleted.
export function syncTodoList(store, content) {
  const summary = { added: 0, completed: 0, reopened: 0, orphaned: 0 }
  const lines = parseTodoLines(content)
  const existing = store.list({ noteId: TODO_LIST_ID, includeClosed: true }).filter((action) => action.origin === 'todo-list')
  const used = new Set()
  for (const line of lines) {
    const key = quoteKey(line.quote)
    const match = existing
      .filter((action) => !used.has(action.id) && action.fingerprint.quoteKey === key)
      .sort((a, b) => Math.abs(a.anchor.from - line.from) - Math.abs(b.anchor.from - line.from))[0]
    if (!match) {
      store.addTodoLine({ text: line.text, checked: line.checked, anchor: { noteId: TODO_LIST_ID, from: line.from, to: line.to, quote: line.quote } })
      summary.added += 1
      continue
    }
    used.add(match.id)
    const { anchor } = match
    if (anchor.from !== line.from || anchor.to !== line.to || anchor.quote !== line.quote || anchor.orphaned) {
      store.setAnchor(match.id, { from: line.from, to: line.to, quote: line.quote, orphaned: false })
    }
    if (line.checked && ['open', 'suggested', 'snoozed'].includes(match.status)) { store.complete(match.id); summary.completed += 1 }
    else if (!line.checked && match.status === 'done') { store.reopen(match.id); summary.reopened += 1 }
  }
  for (const action of existing) {
    if (used.has(action.id) || action.anchor?.orphaned) continue
    store.setAnchor(action.id, { orphaned: true })
    summary.orphaned += 1
  }
  return summary
}

async function readTodoListContent(runtime) {
  const filePath = runtime.resolveBundleMarkdownPath(TODO_LIST_ID)
  if (!filePath) return null
  try {
    await runtime.assertNoBundleSymlinks(filePath)
    return runtime.parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath).content
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function syncTodoListFromDisk(runtime) {
  const store = runtime.actionStore
  if (!store) return null
  const content = await readTodoListContent(runtime)
  return content === null ? null : syncTodoList(store, content)
}

// Flips [ ]/[x] on the exact anchored line of /todo-list.md. Skips the write if that line no longer matches.
export async function setTodoCheckbox(runtime, action, checked) {
  const anchor = action?.anchor
  if (action?.origin !== 'todo-list' || !anchor || anchor.orphaned || anchor.noteId !== TODO_LIST_ID) return false
  const filePath = runtime.resolveBundleMarkdownPath(TODO_LIST_ID)
  if (!filePath) return false
  let written = null
  await runtime.queueMarkdownMutation(async () => {
    await runtime.assertNoBundleSymlinks(filePath)
    const parsed = runtime.parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
    const { from, to, quote } = anchor
    if (parsed.content.slice(from, to) !== quote || !CHECKBOX_LINE.test(quote)) return
    const next = quote.replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]')
    if (next === quote) return
    const content = parsed.content.slice(0, from) + next + parsed.content.slice(to)
    parsed.frontmatter.generated = runtime.updatedGenerated(parsed.frontmatter, 'human:local', new Date().toISOString())
    await fs.writeFile(filePath, runtime.markdownDocument(parsed.frontmatter, content))
    written = next
  })
  if (written === null) return false
  runtime.actionStore.setAnchor(action.id, { quote: written })
  try {
    await runtime.reindexBundle()
    await runtime.history.reconcile(`Updated ${TODO_LIST_ID}`, [TODO_LIST_ID])
  } catch (error) {
    console.error(`The todo list was updated, but it could not be re-indexed or checkpointed: ${error.message}`)
  }
  return true
}
