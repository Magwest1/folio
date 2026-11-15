import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { resolveNoteVariablesForIndex } from '../core/note-variables.js'
import { createSerialQueue } from '../core/queue.js'
import { collectImageText } from './image-text.js'
import { stripTranscriptMarkup } from './transcript-markup.js'

export function createKnowledgeIndex(runtime) {
  const { embedModel, embeddingSchemaVersion,
    listBundleMarkdownFiles, bundleFileId, parseMarkdownFile, markdownRelationships, resolveMarkdownLink, filingPreviousPaths, writeRecords, readRecords,
    normalizeMarkdownBreaks } = runtime
  const updateCachedRecords = (...args) => runtime.updateCachedRecords(...args)
  const semanticSuggestionState = (...args) => runtime.semanticSuggestionState(...args)
  const embedMany = (...args) => runtime.embedMany(...args)
  const recalculateGeneratedRelationships = (...args) => runtime.recalculateGeneratedRelationships(...args)
  const rebuildBundleFiles = (...args) => runtime.rebuildBundleFiles(...args)
  const noteChunks = (...args) => runtime.noteChunks(...args)
  const splitByUtf8Bytes = (...args) => runtime.splitByUtf8Bytes(...args)
  const validEmbedding = (...args) => runtime.validEmbedding(...args)
  const embeddingDimension = (...args) => runtime.embeddingDimension(...args)
  const normalizeEmbeddingDimensions = (...args) => runtime.normalizeEmbeddingDimensions(...args)
  const updateSemanticSuggestions = (...args) => runtime.updateSemanticSuggestions(...args)
  const queueIndexOperation = createSerialQueue()
  const queueMarkdownMutation = createSerialQueue()
// Parsed documents keyed by path. An entry is trusted only while mtime, size and inode still
// match, and only once the file is old enough that a same-tick rewrite cannot hide behind them.
const documentCache = new Map()
const DOCUMENT_CACHE_SETTLE_MS = 1000
const DOCUMENT_READ_CONCURRENCY = 32

function cachedDocumentParts(entry) {
  return { markdown: entry.markdown, parsed: structuredClone(entry.parsed), relationships: structuredClone(entry.relationships) }
}

async function readBundleDocument(filePath) {
  const fileStat = await fs.stat(filePath)
  const id = bundleFileId(filePath)
  const cached = documentCache.get(filePath)
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size && cached.ino === fileStat.ino) {
    return { id, filePath, fileStat, ...cachedDocumentParts(cached) }
  }
  const markdown = await fs.readFile(filePath, 'utf8')
  const parsed = parseMarkdownFile(markdown, filePath)
  const relationships = markdownRelationships(id, parsed)
  if (Date.now() - fileStat.mtimeMs > DOCUMENT_CACHE_SETTLE_MS) {
    documentCache.set(filePath, {
      mtimeMs: fileStat.mtimeMs, size: fileStat.size, ino: fileStat.ino, markdown, parsed: structuredClone(parsed), relationships: structuredClone(relationships),
    })
  } else {
    documentCache.delete(filePath)
  }
  return { id, filePath, fileStat, markdown, parsed, relationships }
}

async function readBundleDocuments() {
  const documents = []
  const errors = []
  const filePaths = (await listBundleMarkdownFiles()).filter((filePath) => {
    const name = path.basename(filePath)
    return name !== 'index.md' && name !== 'log.md'
  })
  const present = new Set(filePaths)
  for (const cachedPath of documentCache.keys()) {
    if (!present.has(cachedPath)) documentCache.delete(cachedPath)
  }
  for (let offset = 0; offset < filePaths.length; offset += DOCUMENT_READ_CONCURRENCY) {
    const batch = filePaths.slice(offset, offset + DOCUMENT_READ_CONCURRENCY)
    const results = await Promise.all(batch.map(async (filePath) => {
      try {
        return { document: await readBundleDocument(filePath) }
      } catch (error) {
        return { error: { id: bundleFileId(filePath), error: error.message } }
      }
    }))
    for (const result of results) {
      if (result.document) documents.push(result.document)
      else errors.push(result.error)
    }
  }
  return { documents, errors }
}

function documentSummary(document) {
  return {
    id: document.id,
    title: document.parsed.title,
    type: document.parsed.type,
    description: document.parsed.description,
    createdAt: document.parsed.generatedAt || document.fileStat.mtime.toISOString(),
  }
}

function semanticSuggestionSummaries(record, records) {
  const recordsById = new Map(records.map((item) => [item.id, item]))
  return (record?.suggestedRelatedIds || []).flatMap((id) => {
    const suggested = recordsById.get(id)
    return suggested ? [{
      id: suggested.id,
      title: suggested.title,
      type: suggested.type,
      description: suggested.description,
      createdAt: suggested.createdAt,
      relation: 'Suggested by meaning',
      origin: 'semantic',
    }] : []
  })
}

async function relationshipIndex() {
  const { documents } = await readBundleDocuments()
  const nodes = new Map(documents.map((document) => [document.id, documentSummary(document)]))
  const aliases = new Map()
  for (const document of documents) {
    for (const previousPath of filingPreviousPaths(document.parsed)) {
      if (!nodes.has(previousPath)) aliases.set(previousPath, document.id)
    }
  }
  const outgoing = new Map()
  const incoming = new Map()

  for (const document of documents) {
    for (const relationship of document.relationships) {
      const targetId = aliases.get(relationship.id) || relationship.id
      if (!nodes.has(targetId)) continue
      const forward = { ...nodes.get(targetId), relation: relationship.relation, origin: relationship.origin }
      const backward = { ...nodes.get(document.id), relation: relationship.relation, origin: relationship.origin }
      outgoing.set(document.id, [...(outgoing.get(document.id) || []), forward])
      incoming.set(targetId, [...(incoming.get(targetId) || []), backward])
    }
  }

  return { outgoing, incoming }
}

function recordIsStale(record, now = new Date()) {
  return Boolean(record.staleAfter && Date.parse(record.staleAfter) <= now.getTime())
}

function lifecycleFactor(record, now = new Date()) {
  if (record.status === 'deprecated') return 0.35
  if (recordIsStale(record, now)) return 0.7
  if (record.status === 'draft') return 0.9
  return 1
}

function publicRecord(record) {
  const {
    embedding: _embedding,
    chunks: _chunks,
    content: _content,
    imageText: _imageText,
    embeddingModel: _embeddingModel,
    embeddingSchemaVersion: _embeddingSchemaVersion,
    embeddingInputHash: _embeddingInputHash,
    suggestedRelatedIds: _suggestedRelatedIds,
    ...value
  } = record
  return { ...value, stale: recordIsStale(record) }
}

function stripGeneratedRelatedSection(content) {
  return String(content).replace(
    /\n?<!-- folio:generated-related:start -->[\s\S]*?<!-- folio:generated-related:end -->\n?/gi,
    '\n',
  )
}

function indexedConceptContent(content) {
  return stripGeneratedRelatedSection(normalizeMarkdownBreaks(content))
    .replace(/\n?<!-- folio:capture:confirmation:[a-f0-9]{24}:start -->[\s\S]*?<!-- folio:capture:confirmation:[a-f0-9]{24}:end -->\n?/g, (capture) => capture
      .replace(/<!-- folio:capture:confirmation:[a-f0-9]{24}:(?:start|end) -->\n?/g, ''))
    .replace(/^# (?:Captured note|Summary)\s*\n+/i, '')
    .trim()
}

function replaceIndexedConceptContent(currentContent, nextContent) {
  const withoutGeneratedRelationships = stripGeneratedRelatedSection(currentContent)
  const wrapper = withoutGeneratedRelationships.match(/^# (?:Captured note|Summary)\s*\n+/i)?.[0]
  if (!wrapper) return nextContent.trim()

  return `${wrapper}${nextContent.trim()}`
}

function isEmbeddingGemma() {
  return /(?:^|\/)embeddinggemma(?:[-/:]|$)/i.test(embedModel)
}

function embeddingQueryInput(query) {
  return isEmbeddingGemma() ? `task: search result | query: ${query}` : query
}

function embeddingDocumentInput(title, text) {
  return isEmbeddingGemma() ? `title: ${title} | text: ${text}` : `${title}\n${text}`
}

function boundedEmbeddingText(value, maxBytes = 1600) {
  const text = String(value)
  return Buffer.byteLength(text) <= maxBytes ? text : splitByUtf8Bytes(text, maxBytes)[0]
}

// OCR text of embedded images is index-only; with no image text every input stays byte-identical.
function indexableText(content) {
  // Variables resolve first so resolved speaker names are stripped as transcript headers too.
  return stripTranscriptMarkup(resolveNoteVariablesForIndex(content))
}

function embeddingBody(record) {
  const content = indexableText(record.content)
  return record.imageText ? `${content}\n${record.imageText}` : content
}

function embeddingInput(record) {
  return embeddingDocumentInput(record.title, boundedEmbeddingText(`${record.description}\n${embeddingBody(record)}`))
}

function embeddingInputHash(record) {
  return crypto.createHash('sha256')
    .update(`${embeddingSchemaVersion}\n${record.title}\n${record.description}\n${embeddingBody(record)}`)
    .digest('hex')
}

function chunkInput(record, content) {
  return embeddingDocumentInput(record.title, content)
}

function chunkInputHash(record, content) {
  return crypto.createHash('sha256').update(`${embeddingSchemaVersion}\n${chunkInput(record, content)}`).digest('hex')
}

function recordChunks(record, previous) {
  const previousChunks = new Map((previous?.chunks || []).map((chunk) => [chunk.embeddingInputHash, chunk]))
  return noteChunks(`${record.description}\n\n${record.imageText ? `${indexableText(record.content)}\n\n${record.imageText}` : indexableText(record.content)}`).map((content) => {
    const embeddingInputHash = chunkInputHash(record, content)
    const previousChunk = previousChunks.get(embeddingInputHash)
    const reusableEmbedding = previous?.embeddingSchemaVersion === embeddingSchemaVersion
      && previous?.embeddingModel === embedModel
      && validEmbedding(previousChunk?.embedding)
    return {
      content,
      embedding: reusableEmbedding ? previousChunk.embedding : null,
      embeddingInputHash,
    }
  })
}

async function refreshRecordEmbeddings(records, errors = []) {
  let expectedDimension = embeddingDimension(records)
  const tasks = []
  for (const record of records) {
    if (!record.embedding) {
      tasks.push({ input: embeddingInput(record), assign: (embedding) => { record.embedding = embedding } })
    }
    for (const chunk of record.chunks || []) {
      if (!chunk.embedding) {
        tasks.push({ input: chunkInput(record, chunk.content), assign: (embedding) => { chunk.embedding = embedding } })
      }
    }
  }

  for (let offset = 0; offset < tasks.length; offset += 32) {
    const batch = tasks.slice(offset, offset + 32)
    try {
      const embeddings = await embedMany(batch.map((task) => task.input), expectedDimension)
      expectedDimension ||= embeddings[0].length
      batch.forEach((task, index) => task.assign(embeddings[index]))
    } catch (error) {
      errors.push({ id: 'embeddings', error: `Could not refresh embeddings: ${error.message}` })
    }
  }

  return errors
}

function indexedRecordsFromDocuments(documents, previousRecords, imageText = new Map()) {
  const documentIds = new Set(documents.map((document) => document.id))
  return documents
    .filter((document) => document.parsed.type !== 'Raw Capture')
    .map((document) => {
      const previous = previousRecords.get(document.id)
      const rawSource = document.parsed.sources.find((source) => String(source?.id || '').startsWith('raw-capture'))
      const content = indexedConceptContent(document.parsed.content)
      const record = {
        id: document.id,
        rawId: rawSource?.resource ? resolveMarkdownLink(document.id, rawSource.resource) || String(rawSource.resource) : null,
        title: document.parsed.title,
        type: document.parsed.type,
        description: document.parsed.description,
        tags: document.parsed.tags,
        status: document.parsed.status,
        staleAfter: document.parsed.staleAfter,
        relatedIds: Array.from(new Set(
          document.relationships.map((relationship) => relationship.id).filter((id) => documentIds.has(id)),
        )),
        content,
        imageText: imageText.get(document.id) || '',
        createdAt: document.parsed.generatedAt || document.fileStat.birthtime.toISOString(),
        updatedAt: document.fileStat.mtime.toISOString(),
        classifiedByModel: !String(document.parsed.frontmatter.generated?.by || '').startsWith('human:'),
        filedBy: document.parsed.filedBy,
        filedAt: document.parsed.filedAt,
        embedding: null,
        embeddingModel: embedModel,
        embeddingSchemaVersion,
        embeddingInputHash: null,
        chunks: [],
        suggestedRelatedIds: [],
      }
      const currentHash = embeddingInputHash(record)
      const previousHash = previous?.embeddingInputHash || (previous ? embeddingInputHash(previous) : null)
      const embeddingStillMatches = previous?.embedding
        && previous.embeddingModel === embedModel
        && previous.embeddingSchemaVersion === embeddingSchemaVersion
        && previousHash === currentHash
        && validEmbedding(previous.embedding)
      record.embedding = embeddingStillMatches ? previous.embedding : null
      record.embeddingInputHash = currentHash
      // The record hash covers every chunk input, so an unchanged hash means unchanged chunks.
      const chunksStillMatch = previousHash === currentHash
        && previous.embeddingModel === embedModel
        && previous.embeddingSchemaVersion === embeddingSchemaVersion
        && Array.isArray(previous.chunks)
        && previous.chunks.length > 0
        && previous.chunks.every((chunk) => typeof chunk?.content === 'string' && chunk.embeddingInputHash)
      record.chunks = chunksStillMatch
        ? previous.chunks.map((chunk) => ({
          content: chunk.content,
          embedding: validEmbedding(chunk.embedding) ? chunk.embedding : null,
          embeddingInputHash: chunk.embeddingInputHash,
        }))
        : recordChunks(record, previous)
      return record
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

async function readImageText(documents) {
  try {
    return await collectImageText(documents, {
      bundleRoot: typeof runtime.getBundleRoot === 'function' ? runtime.getBundleRoot() : runtime.bundleRoot,
      assertNoBundleSymlinks: (...args) => runtime.assertNoBundleSymlinks(...args),
    })
  } catch {
    return new Map()
  }
}

async function performReindexBundle({ refreshEmbeddings = false, markdownLocked = false } = {}) {
  const previousRecords = await readRecords()
  const suggestionState = semanticSuggestionState(previousRecords)
  const existing = new Map(previousRecords.map((record) => [record.id, record]))
  let { documents, errors } = await readBundleDocuments()
  let records = indexedRecordsFromDocuments(documents, existing, await readImageText(documents))

  normalizeEmbeddingDimensions(records)

  if (refreshEmbeddings) {
    await refreshRecordEmbeddings(records, errors)
  }

  if (markdownLocked) await recalculateGeneratedRelationships(records, documents)
  else await queueMarkdownMutation(() => recalculateGeneratedRelationships(records, documents))
  const refreshedBundle = await readBundleDocuments()
  documents = refreshedBundle.documents
  errors.push(...refreshedBundle.errors)
  records = indexedRecordsFromDocuments(documents, new Map(records.map((record) => [record.id, record])), await readImageText(documents))
  normalizeEmbeddingDimensions(records)
  if (markdownLocked) await recalculateGeneratedRelationships(records, documents)
  else await queueMarkdownMutation(() => recalculateGeneratedRelationships(records, documents))
  const finalBundle = await readBundleDocuments()
  documents = finalBundle.documents
  errors.push(...finalBundle.errors)
  records = indexedRecordsFromDocuments(documents, new Map(records.map((record) => [record.id, record])), await readImageText(documents))
  normalizeEmbeddingDimensions(records)
  const documentIds = new Set(documents.map((document) => document.id))
  const relationshipsById = new Map(documents.map((document) => [document.id, document.relationships]))
  for (const record of records) {
    record.relatedIds = Array.from(new Set(
      (relationshipsById.get(record.id) || []).map((relationship) => relationship.id).filter((id) => documentIds.has(id)),
    ))
  }
  updateSemanticSuggestions(records, suggestionState)
  await writeRecords(records)
  await rebuildBundleFiles(records)
  return { records, errors }
}

function reindexBundle(options) {
  return queueIndexOperation(() => performReindexBundle(options))
}

// Rebuilds just one note's record from its freshly written file and updates the in-memory index
// only. The deferred full reindex persists it and refreshes relationships. Must run inside the
// index queue. Returns null when the note has no record yet so the caller can reindex fully.
async function indexSavedNote(id, filePath) {
  const records = await readRecords()
  const index = records.findIndex((record) => record.id === id)
  if (index === -1) return null
  const previous = records[index]
  const document = await readBundleDocument(filePath)
  if (document.parsed.type === 'Raw Capture') return null
  const [record] = indexedRecordsFromDocuments([document], new Map([[id, previous]]), await readImageText([document]))
  if (!record) return null
  record.relatedIds = previous.relatedIds || []
  record.suggestedRelatedIds = record.embedding ? previous.suggestedRelatedIds || [] : []
  records[index] = record
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  await updateCachedRecords(records)
  scheduleDeferredReindex()
  return { record, records }
}

const DEFERRED_REINDEX_DELAY_MS = 2000
const DEFERRED_REINDEX_MAX_WAIT_MS = 30000
let deferredTimer = null
let deferredFirstScheduledAt = 0
const deferredRuns = new Set()

function runDeferredReindex() {
  deferredTimer = null
  deferredFirstScheduledAt = 0
  const run = reindexBundle().catch((error) => {
    if (error?.code !== 'ENOENT') console.error(`The deferred bundle reindex failed: ${error.message}`)
  })
  deferredRuns.add(run)
  void run.finally(() => deferredRuns.delete(run))
  return run
}

// Trailing debounce: bursts of autosaves share one full reindex, but a continuous burst cannot starve it.
function scheduleDeferredReindex() {
  const now = Date.now()
  if (deferredTimer) clearTimeout(deferredTimer)
  else deferredFirstScheduledAt = now
  const delay = Math.max(0, Math.min(
    runtime.deferredReindexDelayMs ?? DEFERRED_REINDEX_DELAY_MS,
    deferredFirstScheduledAt + DEFERRED_REINDEX_MAX_WAIT_MS - now,
  ))
  deferredTimer = setTimeout(runDeferredReindex, delay)
  deferredTimer.unref?.()
}

async function flushDeferredReindex() {
  while (deferredTimer || deferredRuns.size) {
    if (deferredTimer) {
      clearTimeout(deferredTimer)
      runDeferredReindex()
    }
    await Promise.all([...deferredRuns])
  }
}

async function persistEmbeddingUpdatesNow(updatedRecords) {
  const records = await readRecords()
  const suggestionState = semanticSuggestionState(records)
  const updatesById = new Map(updatedRecords.map((record) => [record.id, record]))
  for (const record of records) {
    const update = updatesById.get(record.id)
    if (!update || record.embeddingInputHash !== update.embeddingInputHash) continue
    record.embedding = update.embedding
    record.embeddingModel = update.embeddingModel
    record.embeddingSchemaVersion = update.embeddingSchemaVersion
    record.chunks = update.chunks
  }
  normalizeEmbeddingDimensions(records)
  updateSemanticSuggestions(records, suggestionState)
  await writeRecords(records)
  return records
}

function persistEmbeddingUpdates(updatedRecords) {
  return queueIndexOperation(() => persistEmbeddingUpdatesNow(updatedRecords))
}


  return { readBundleDocuments, documentSummary, semanticSuggestionSummaries, relationshipIndex, recordIsStale,
    lifecycleFactor, publicRecord, stripGeneratedRelatedSection, indexedConceptContent, replaceIndexedConceptContent,
    isEmbeddingGemma, embeddingQueryInput, embeddingDocumentInput, boundedEmbeddingText, embeddingInput,
    embeddingInputHash, chunkInput, chunkInputHash, recordChunks, refreshRecordEmbeddings,
    indexedRecordsFromDocuments, performReindexBundle, queueIndexOperation, reindexBundle, queueMarkdownMutation,
    persistEmbeddingUpdatesNow, persistEmbeddingUpdates, readBundleDocument, indexSavedNote, scheduleDeferredReindex,
    flushDeferredReindex }
}
