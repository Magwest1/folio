// Seeds a fresh demo bundle by filing fictional notes through the real app API (local model).
import fs from 'node:fs'
import path from 'node:path'
import { prepareDemoDirs, launch, api, workDir } from './lib.mjs'
import { notes } from './demo/notes.mjs'
import { renderCard } from './demo/make-ocr-image.mjs'
import { renderSketch } from './demo/make-sketch-image.mjs'

prepareDemoDirs({ fresh: true })
const { app, base } = await launch()
const ids = {}
try {
  // Upload the generated recipe-card image as a bundle asset for the OCR demo note.
  const cardPng = path.join(workDir, 'cardamom-buns-recipe-card.png')
  await renderCard(cardPng)
  const upload = await fetch(base + '/api/assets', { method: 'POST', headers: { 'content-type': 'image/png', 'x-folio-filename': 'cardamom-buns-recipe-card.png' }, body: fs.readFileSync(cardPng) })
  const { path: cardAsset } = await upload.json()
  console.log('card asset', cardAsset)
  // Same for the generated whiteboard photo used by the image description screenshots.
  const sketchPng = path.join(workDir, 'lumen-checklist-sketch.png')
  await renderSketch(sketchPng)
  const sketchUpload = await fetch(base + '/api/assets', { method: 'POST', headers: { 'content-type': 'image/png', 'x-folio-filename': 'lumen-checklist-sketch.png' }, body: fs.readFileSync(sketchPng) })
  const { path: sketchAsset } = await sketchUpload.json()
  console.log('sketch asset', sketchAsset)
  for (const n of notes) {
    const content = n.content.replaceAll('__CARD_ASSET__', cardAsset).replaceAll('__SKETCH_ASSET__', sketchAsset)
    const t = Date.now()
    const res = await api(base, 'POST', '/api/notes', { content, timeZone: 'Europe/Oslo' })
    if (res.filing?.id && res.filing.mode !== 'append') {
      await api(base, 'POST', '/api/filing/confirm', { filingId: res.filing.id, action: 'accept' }).catch((e) => console.log('confirm', e.message))
    }
    ids[n.key] = res.note.id
    console.log(n.key, '->', res.note.id, `(${res.filing?.mode}, ${Date.now() - t}ms)`)
  }
  fs.writeFileSync(path.join(workDir, 'ids.json'), JSON.stringify(ids, null, 2))
} finally {
  await app.close()
}
