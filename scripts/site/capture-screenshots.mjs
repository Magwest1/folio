// Captures marketing screenshots of the FolioNotes desktop app (Electron) against
// a fictional demo bundle. Never touches ~/Documents/Folio or the real userData.
//
//   node scripts/site/seed-demo.mjs --app-root <app>       # fresh demo bundle (uses local model)
//   node scripts/site/enrich-demo.mjs --app-root <app>     # links + history revisions
//   node scripts/site/capture-screenshots.mjs --app-root <app> [--only hero,models] [--out dir] [--with-dark]
//   node scripts/site/to-webp.mjs                          # PNG -> WebP (then delete the PNGs; only .webp ships)
//
// The marketing site is light-theme only, so by default every step saves just `<name>-light.png`.
// Pass --with-dark to also save the dark default (`<name>.png`) as the pre-0.9 site did.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launch, api, argValue, here, workDir } from './lib.mjs'
import { buildMeeting } from './demo/make-meeting-audio.mjs'

const out = path.resolve(argValue('--out', path.join(here, '..', '..', 'site', 'assets', 'screenshots')))
const only = argValue('--only', '')?.split(',').filter(Boolean)
fs.mkdirSync(out, { recursive: true })
const ids = JSON.parse(fs.readFileSync(path.join(workDir, 'ids.json'), 'utf8'))

const { app, page, base, docs } = await launch({ reset: true })
const results = []
await (async () => { await new Promise((r) => setTimeout(r, 2500)) })()
const sleep = (ms) => page.waitForTimeout(ms)
const sizes = {}
const setTheme_ = (id, scheme) => page.evaluate(([i, c]) => { document.documentElement.dataset.theme = i; document.documentElement.style.colorScheme = c }, [id, scheme])
// Saves the shot in the dark default theme, then again with a -light suffix (hero-dark -> hero-light).
async function shotBoth(name, target = page, opts = {}) {
  const lightName = name === 'hero-dark.png' ? 'hero-light.png' : name.replace(/\.png$/, '-light.png')
  const take = async (n) => { const b = await target.screenshot({ path: path.join(out, n), animations: 'disabled', ...opts }); sizes[n] = `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` }
  await take(name)
  await setTheme_('light', 'light')
  await sleep(500)
  await take(lightName)
  await setTheme_('original', 'dark')
  await sleep(400)
}
// Light-theme-only shot: saves `<name>-light.png`, then restores the dark default.
async function shotLightOnly(name, target = page, opts = {}) {
  await setTheme_('light', 'light')
  await sleep(600)
  const n = `${name}-light.png`
  const b = await target.screenshot({ path: path.join(out, n), animations: 'disabled', ...opts })
  sizes[n] = `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
  await setTheme_('original', 'dark')
  await sleep(400)
}
// Default for every step: light only (`hero-dark.png` -> hero-light.png, `x.png` -> x-light.png).
const withDark = process.argv.includes('--with-dark')
const shot = (name, target = page, opts = {}) => withDark
  ? shotBoth(name, target, opts)
  : shotLightOnly(name === 'hero-dark.png' ? 'hero' : name.replace(/\.png$/, ''), target, opts)
async function around(locator, margin = 24) {
  const b = await locator.boundingBox()
  return { clip: { x: Math.max(0, b.x - margin), y: Math.max(0, b.y - margin), width: b.width + margin * 2, height: b.height + margin * 2 } }
}

async function settle() {
  await page.mouse.move(1000, 12)
  await sleep(400)
}
async function setSidebar(mode) {
  await page.locator('nav.sidebar-tabs button', { hasText: new RegExp(`^${mode}$`, 'i') }).first().click()
  await sleep(300)
}
async function openNote(title) {
  await setSidebar('explore')
  const f = page.locator('button.tree-file').filter({ hasText: title }).first()
  await f.scrollIntoViewIfNeeded()
  await f.click()
  await sleep(1200)
  await settle()
}
async function scrollNote(to) {
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      const cx = r.x + r.width / 2
      if (cx > 330 && cx < 1130 && r.height > 300 && el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = t === 'end' ? 99999 : t
    }
  }, to)
  await sleep(400)
}
async function openSettings(category) {
  await page.getByRole('button', { name: /^settings$/i }).click()
  await page.locator('.settings-dialog').waitFor()
  if (category) await page.locator(`[data-settings-category="${category}"]`).click()
  await sleep(600)
}
async function closeSettings() {
  await page.locator('.settings-close').click()
  await sleep(400)
}
async function prepare() {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('button.tree-file').first().waitFor({ timeout: 30000 })
  const gs = page.locator('button.tree-directory').filter({ hasText: /getting-started/ })
  if (await gs.getAttribute('aria-expanded') === 'true') await gs.click()
  const rc = page.getByRole('button', { name: 'Collapse Recent concepts' })
  if (await rc.count()) await rc.click()
  await sleep(500)
}

const steps = {
  async filing() {
    await setSidebar('explore')
    await page.keyboard.press('Meta+t')
    const draft = page.getByRole('textbox', { name: 'Write a new note' })
    await draft.waitFor()
    await draft.fill(`Meeting notes: Lumen weekly design sync\n\n**Attendees:** Maya, Jonas, Priya\n\n## Discussion\n- Checklist component is ready for engineering handoff\n- Agreed to track activation per step, not just per session\n- Invite step moves above the fold in the next prototype\n\n## Action items\n- [ ] Maya: export final checklist specs\n- [ ] Priya: add step-level analytics events`)
    await sleep(500)
    await page.keyboard.press('Meta+Enter')
    await page.getByRole('dialog', { name: 'Filing confirmation' }).waitFor({ timeout: 120000 })
    await sleep(1500)
    await settle()
    await shot('capture-filing.png')
    await shot('filing-dialog.png', page, await around(page.getByRole('dialog', { name: 'Filing confirmation' })))
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: 'Filing confirmation' }).waitFor({ state: 'detached', timeout: 60000 })
    await sleep(2500)
  },
  async hero() {
    await openNote(/Lumen onboarding redesign/)
    await scrollNote(0)
    await shot('hero-dark.png')
  },
  async explorer() {
    await setSidebar('explore')
    await page.evaluate(() => document.querySelectorAll('.workbench-sidebar *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0 }))
    await sleep(400)
    const panel = page.locator('.sidebar-panel').first()
    const box = await panel.boundingBox()
    const last = await page.locator('button.tree-file').last().boundingBox()
    await shot('explorer.png', page, { clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, last.y + last.height + 14 - box.y) } })
  },
  async models() {
    await openSettings('models')
    await shot('models.png')
    await shot('settings-models.png', page.locator('.settings-dialog'))
    const box = await page.locator('#settings-panel-models .model-settings-group').first().boundingBox()
    await shot('models-card.png', page, { clip: { x: box.x - 8, y: box.y - 4, width: box.width + 16, height: box.height + 8 } })
    await closeSettings()
  },
  async search() {
    await setSidebar('search')
    await page.getByLabel('Search your notes').fill('how did usability testing go')
    await page.keyboard.press('Enter')
    await sleep(7000)
    await settle()
    await shot('search.png')
    await shot('search-pane.png', page.locator('aside.workbench-sidebar'))
  },
  async ask() {
    await setSidebar('ask')
    await page.getByLabel('Question for your notes').fill('What did we learn from the first Lumen usability test, and what are we changing?')
    await page.getByRole('button', { name: /ask notes/i }).click()
    await page.getByRole('button', { name: /thinking/i }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: /thinking/i }).waitFor({ state: 'detached', timeout: 480000 })
    await sleep(2500)
    await page.locator('.workbench-sidebar a', { hasText: /Lumen usability test/ }).first().click()
    await sleep(1800)
    await settle()
    await shot('ask.png')
    await page.evaluate(() => document.querySelectorAll('.workbench-sidebar *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0 }))
    await sleep(300)
    await shot('ask-pane.png', page.locator('aside.workbench-sidebar'))
  },
  async history() {
    await openNote(/Lumen usability test/)
    await page.getByRole('button', { name: /Older/ }).click()
    await sleep(1800)
    await page.getByRole('button', { name: /Older/ }).click()
    await sleep(1800)
    await settle()
    await shot('history.png')
    await shot('history-crop.png', page.locator('aside.workspace-right-pane [role=tabpanel]'))
    await page.getByRole('button', { name: /Newer/ }).click().catch(() => {})
    await page.getByRole('button', { name: /Newer/ }).click().catch(() => {})
    await sleep(600)
  },
  async links() {
    await openNote(/Lumen usability test/)
    await scrollNote('end')
    await settle()
    await shot('links.png')
    const rel = await page.getByText('Related', { exact: true }).first().boundingBox()
    const top = Math.max(60, rel.y - 380)
    await shot('links-crop.png', page, { clip: { x: 324, y: top, width: 796, height: Math.min(Math.round(rel.y + 220), 860) - top } })
  },
  async refile() {
    await openNote(/Weekend sourdough/)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Refile/ }).click()
    await page.getByRole('dialog', { name: 'Refile note' }).waitFor()
    await page.waitForFunction(() => !/Choosing a path/.test(document.querySelector('[role=dialog][aria-label="Refile note"]')?.textContent || ''), null, { timeout: 180000 })
    await sleep(1200)
    await settle()
    await shot('refile.png')
    await shot('refile-dialog.png', page, await around(page.getByRole('dialog', { name: 'Refile note' })))
    await page.keyboard.press('Escape')
    await sleep(600)
  },
  async export() {
    await openNote(/Lumen usability test/)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await sleep(500)
    await shot('export.png', page, { clip: { x: 300, y: 0, width: 830, height: 891 } })
    await page.keyboard.press('Escape')
  },
  async transcription() {
    // Synthetic three-voice meeting made with macOS `say` (see demo/make-meeting-audio.mjs).
    const audio = buildMeeting(path.join(workDir, 'lumen-design-sync.m4a'))
    await page.getByRole('tab', { name: /transcription/i }).click()
    await page.locator('input[aria-label="Choose local audio file"]').setInputFiles(audio)
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click()
    const play = page.getByRole('button', { name: /^Play lumen-design-sync/ })
    await play.waitFor({ timeout: 600000 })
    await sleep(1500)
    // Expand the player and name the speakers (Rename pencil beside each chip).
    await page.locator('button.transcription-row-main').first().click()
    await page.locator('.player-chips').waitFor()
    const chips = await page.locator('.player-chip-name').allTextContents()
    console.log('speakers found:', chips.join(', '))
    const names = ['Maya', 'Jonas', 'Priya']
    for (let i = 0; i < chips.length; i++) {
      await page.getByRole('button', { name: `Rename ${chips[i]}` }).click()
      const input = page.locator('.player-chip-input')
      await input.fill(names[i])
      await input.press('Enter')
      await page.locator('.player-note', { hasText: 'Name saved' }).waitFor({ timeout: 15000 })
      await sleep(400)
    }
    // The recording summary is generated automatically after transcription; wait for the local model to go idle.
    for (let i = 0; i < 60; i++) {
      const st = await api(base, 'GET', '/api/mlx/status')
      if (!st.models.some((m) => m.busy || m.loading)) break
      await sleep(3000)
    }
    await sleep(2500)
    // Drop the plain draft the transcription opened on its own, then open the draft that is linked to the
    // recording with speakers: names become note variables (`speaker1:: Maya`) and follow renames.
    await setSidebar('explore')
    await page.locator('button[title="Delete draft"]').first().click()
    await sleep(800)
    await page.getByRole('button', { name: /^More actions for lumen-design-sync/ }).click()
    await page.getByRole('menuitem', { name: 'Open draft with speakers' }).click()
    await sleep(2500)
    for (let i = 0; i < 60; i++) {
      const st = await api(base, 'GET', '/api/mlx/status')
      if (!st.models.some((m) => m.busy || m.loading)) break
      await sleep(3000)
    }
    await sleep(2000)
    // Seek into the middle of the meeting so the playhead and current speaker show.
    const lanes = page.locator('.player-lanes, .player-lane').first()
    if (await lanes.count()) { const b = await lanes.boundingBox(); await page.mouse.click(b.x + b.width * 0.42, b.y + b.height / 2) }
    await sleep(1200)
    console.log('draft tabs:', await page.locator('button.tree-file').filter({ hasText: /Source audio/ }).count())
    // Collapse the model status list, scroll the right pane to the recording row and the note to its transcript.
    const mlx = page.locator('button[aria-expanded="true"]').filter({ hasText: /MLX/ }).first()
    if (await mlx.count()) { await mlx.click(); await sleep(400) }
    await page.evaluate(() => document.querySelectorAll('aside.workspace-right-pane *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0 }))
    await scrollNote(620)
    await sleep(600)
    await settle()
    await shot('transcription.png')
    await shot('transcription-crop.png', page, { clip: { x: 316, y: 0, width: 1124, height: 891 } })
    await page.getByRole('tab', { name: /history/i }).click()
  },
  async ocr() {
    await openNote(/Cardamom/i)
    await scrollNote(0)
    const img = page.locator('.cm-live-markdown-image-frame img').first()
    await img.scrollIntoViewIfNeeded()
    await img.hover()
    await sleep(500)
    await page.getByRole('toolbar', { name: 'Image actions' }).first().getByRole('button', { name: 'Extract text' }).click()
    const panel = page.getByLabel('Extracted text')
    await panel.waitFor({ timeout: 180000 })
    await sleep(1500)
    await img.evaluate((el) => { el.scrollIntoView({ block: 'start' }); for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { p.scrollTop += 34; break } })
    await sleep(400)
    await img.hover()
    await sleep(500)
    await shotLightOnly('ocr')
    const a = await img.boundingBox(), b = await panel.boundingBox()
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height)
    const m = 28, top = Math.max(40, y0 - 14), bottom = y1 + 6
    await shotLightOnly('ocr-crop', page, { clip: { x: Math.max(0, x0 - m), y: top, width: x1 - x0 + 2 * m, height: bottom - top } })
  },
  async describe() {
    // Needs a caption model chosen in Settings -> Models (Qwen 3.5 4B or Gemma 4 E4B). The choice lives in the model
    // cache's caption-model.json, which this pipeline never writes: it only uses what is already selected.
    await openNote(/Whiteboard sketch/i)
    await scrollNote(0)
    const img = page.locator('.cm-live-markdown-image-frame img').first()
    await img.scrollIntoViewIfNeeded()
    await img.hover()
    await sleep(500)
    await page.getByRole('toolbar', { name: 'Image actions' }).first().getByRole('button', { name: 'Describe image' }).click()
    const panel = page.getByLabel('Image description', { exact: true })
    await panel.waitFor({ timeout: 300000 })
    await sleep(1500)
    await img.evaluate((el) => { el.scrollIntoView({ block: 'start' }); for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { p.scrollTop += 34; break } })
    await sleep(400)
    await img.hover()
    await sleep(500)
    await shotLightOnly('describe')
    const a = await img.boundingBox(), b = await panel.boundingBox()
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height)
    const m = 28, top = Math.max(40, y0 - 14), bottom = y1 + 6
    await shotLightOnly('describe-crop', page, { clip: { x: Math.max(0, x0 - m), y: top, width: x1 - x0 + 2 * m, height: bottom - top } })
  },
  async translate() {
    await openNote(/Lumen-workshop/i)
    await scrollNote(0)
    const sw = page.getByRole('switch', { name: 'Auto-translate this note' })
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click()
    const en = page.getByRole('group', { name: 'Note language' }).getByRole('button', { name: 'English' })
    await en.waitFor()
    if ((await en.getAttribute('aria-pressed')) !== 'true') await en.click()
    await page.waitForFunction(() => !/Translating|pending/i.test(document.body.innerText), null, { timeout: 120000 }).catch(() => {})
    await sleep(2500)
    await settle()
    await shotLightOnly('translate')
    await shotLightOnly('translate-crop', page, { clip: { x: 316, y: 0, width: 800, height: 650 } })
  },
  async player() {
    // Close-ups of the speaker player. Run together with the transcription step (`--only transcription,player`):
    // that step creates, names and seeks the recording this one photographs.
    await page.getByRole('tab', { name: /transcription/i }).click()
    await sleep(600)
    const mlx = page.locator('button[aria-expanded="true"]').filter({ hasText: /MLX/ }).first()
    if (await mlx.count()) { await mlx.click(); await sleep(400) }
    const panel = page.locator('.player-panel').first()
    if (!(await panel.count())) { await page.locator('button.transcription-row-main').first().click(); await panel.waitFor() }
    const lanes = page.locator('.player-lanes').first()
    const lb = await lanes.boundingBox()
    await page.mouse.click(lb.x + lb.width * 0.42, lb.y + lb.height / 2)
    await sleep(1200)
    await panel.evaluate((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollTop) p.scrollTop = 0 })
    await sleep(400)
    await settle()
    await shotLightOnly('player', panel)
  },
  async imageTools() {
    // Tight toolbar close-ups (hovered button ringed) plus the result panels they open. The demo bundle's caption and OCR
    // caches are cleared first so the panels show fresh results instead of "(cached)".
    for (const d of ['caption-cache', 'ocr-cache']) fs.rmSync(path.join(docs, 'Folio', 'bundle', '.folio', d), { recursive: true, force: true })
    const marks = {}
    for (const [note, button, panelLabel, name] of [[/Cardamom/i, 'Extract text', 'Extracted text', 'ocr'], [/Whiteboard sketch/i, 'Describe image', 'Image description', 'describe']]) {
      await openNote(note)
      await scrollNote(0)
      await page.addStyleTag({ content: '.cm-live-markdown-image-resize{display:none!important}.cm-live-markdown-ocr-text{max-height:190px!important}' })
      const img = page.locator('.cm-live-markdown-image-frame img').first()
      await img.scrollIntoViewIfNeeded()
      await img.hover()
      await sleep(400)
      const bar = page.getByRole('toolbar', { name: 'Image actions' }).first()
      const btn = bar.getByRole('button', { name: button })
      await btn.hover()
      // Keep the toolbar shown through the theme switch that shotLightOnly performs.
      await page.addStyleTag({ content: '.cm-live-markdown-image-toolbar{opacity:1!important;pointer-events:auto!important}' })
      await btn.evaluate((el) => { el.style.outline = '2px solid #245ea8'; el.style.outlineOffset = '1px'; el.style.background = 'rgba(36,94,168,.14)' })
      await sleep(400)
      const tb = await bar.boundingBox(), bb = await btn.boundingBox()
      const clip = { x: tb.x - 56, y: tb.y - 18, width: tb.width + 56 + 18, height: tb.height + 18 + 34 }
      marks[name] = { button, pos: Number((((bb.x + bb.width / 2) - clip.x) / clip.width).toFixed(3)) }
      await shotLightOnly(`${name}-toolbar`, page, { clip })
      await btn.click()
      const panel = page.getByLabel(panelLabel, { exact: true })
      await panel.waitFor({ timeout: 300000 })
      await sleep(1500)
      await img.evaluate((el) => { el.scrollIntoView({ block: 'start' }); for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { p.scrollTop += 34; break } })
      await sleep(500)
      const pb = await panel.boundingBox()
      await shotLightOnly(`${name}-result`, page, { clip: { x: pb.x - 2, y: pb.y - 2, width: pb.width + 4, height: pb.height + 4 } })
    }
    console.log('toolbar button positions (fraction of crop width):', JSON.stringify(marks))
  },
  async translateToggle() {
    await openNote(/Lumen-workshop/i)
    await scrollNote(0)
    const sw = page.getByRole('switch', { name: 'Auto-translate this note' })
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click()
    const grp = page.getByRole('group', { name: 'Note language' })
    const go = async (wantEn) => {
      // Norwegian is this note's original language, so "no" means no choice: press EN again to go back to the original.
      const bt = grp.getByRole('button', { name: 'English' })
      if (((await bt.getAttribute('aria-pressed')) === 'true') !== wantEn) await bt.click()
      await page.waitForFunction(() => !/Translating|pending/i.test(document.body.innerText), null, { timeout: 120000 }).catch(() => {})
      await sleep(2500)
      await page.mouse.move(1000, 12)
      await sleep(400)
    }
    const a = await sw.boundingBox(), g = await grp.boundingBox()
    // Title row plus the controls (the description line under the title is cropped out), and the note body.
    const head = { x: 316, y: 44, width: 800, height: 76 }
    const body = { x: 316, y: 196, width: 800, height: 220 }
    for (const [wantEn, tag] of [[false, 'no'], [true, 'en']]) {
      await go(wantEn)
      await page.evaluate(([x, y, w, h]) => {
        const r = document.createElement('div')
        r.id = 'capture-ring'
        r.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:2px solid #245ea8;border-radius:10px;box-shadow:0 0 0 4px rgba(36,94,168,.18);pointer-events:none;z-index:99999`
        document.body.append(r)
      }, [a.x - 6, a.y - 6, g.x + g.width - a.x + 12, a.height + 12])
      await shotLightOnly(`translate-toggle-${tag}`, page, { clip: head })
      await page.evaluate(() => document.getElementById('capture-ring')?.remove())
      await shotLightOnly(`translate-${tag}`, page, { clip: body })
    }
      // Large close-up of the note header controls (EN active), with button offsets for the page's callout labels.
    const ge = await grp.boundingBox(), ae = await sw.boundingBox()
    const en = await grp.getByRole('button', { name: 'English' }).boundingBox()
    const clip = { x: ge.x + ge.width + 14 - 200, y: ae.y - 14, width: 200, height: ae.height + 28 }
    await shotLightOnly('translate-controls', page, { clip })
    const frac = (bb) => Number((((bb.x + bb.width / 2) - clip.x) / clip.width).toFixed(3))
    console.log('translate-controls label offsets (fraction of crop width):', JSON.stringify({ switch: frac(ae), languages: frac(ge), en: frac(en) }))
  },
  async translatedExport() {
    await openNote(/Lumen-workshop/i)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: /Translate/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Translate and export' })
    await dlg.waitFor()
    await sleep(800)
    await shotLightOnly('translated-export', page, await around(dlg, 40))
    await page.keyboard.press('Escape')
    await sleep(500)
  },
  async okf() {
    const f = path.join(docs, 'Folio', 'bundle', ids.usability.slice(1))
    fs.copyFileSync(f, path.join(out, 'okf-note.md'))
  },
}
const order = ['hero', 'explorer', 'models', 'search', 'links', 'history', 'refile', 'export', 'filing', 'ask', 'transcription', 'player', 'ocr', 'describe', 'imageTools', 'translate', 'translateToggle', 'translatedExport', 'okf']
export { steps }

await prepare()
for (const name of order) {
  const fn = steps[name]
  if (only?.length && !only.includes(name)) continue
  try { await fn(); results.push(`ok ${name}`) } catch (e) { results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: path.join(workDir, `fail-${name}.png`) }).catch(() => {}) }
}
console.log(results.join('\n'))
console.log(Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join('\n'))
await app.close()
