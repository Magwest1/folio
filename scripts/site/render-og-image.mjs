/**
 * Renders site/assets/og-image.png (1200x630) from the layout below using
 * Playwright Chromium. Fonts (Inter Tight, Inter, JetBrains Mono) are loaded
 * from Google Fonts, so network access is required. Keep the layout in sync
 * with site/assets/og-image.svg (the editable vector source).
 *
 * Usage: node scripts/site/render-og-image.mjs
 */
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const shot = pathToFileURL(join(root, "site/assets/screenshots/transcription-crop-light.webp")).href;
const mark = `<svg viewBox="0 0 1024 1024" width="52" height="52"><rect width="1024" height="1024" rx="220" fill="#161816"/><rect x="190" y="190" width="644" height="644" fill="none" stroke="#b7d892" stroke-width="28"/><g transform="translate(85 0) skewX(-8)" fill="none" stroke="#b7d892" stroke-width="46" stroke-linecap="square" stroke-linejoin="miter"><path d="M290 700V330H500M290 510H460"/><path d="M580 700V470M580 545C580 495 615 468 660 468C710 468 740 500 740 552V700"/></g></svg>`;
const html = `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;position:relative;background:#fafbfc;color:#14171c;font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased}
.dots{position:absolute;right:0;top:0;width:640px;height:630px;background-image:radial-gradient(rgba(20,23,28,.14) 1px,transparent 1.2px);background-size:22px 22px;-webkit-mask-image:linear-gradient(90deg,transparent,#000 40%)}
.brand{position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:16px;font:600 34px "Inter Tight";letter-spacing:-.01em}
.brand svg{border-radius:12px}
h1{position:absolute;left:64px;top:170px;font:700 68px/1.04 "Inter Tight";letter-spacing:-.015em}
.pill{position:absolute;left:64px;top:398px;display:inline-flex;align-items:center;gap:12px;padding:7px 20px 7px 7px;border:1px solid #dde2ea;border-radius:999px;background:#fff;font:500 22px Inter}
.pill b{background:#245ea8;color:#fff;border-radius:999px;padding:4px 14px;font:500 20px "JetBrains Mono"}
.sub{position:absolute;left:64px;top:470px;width:500px;font-size:27px;line-height:1.35;color:#566070;letter-spacing:-.01em}
.win{position:absolute;left:630px;top:130px;width:600px;border-radius:12px;box-shadow:0 0 0 1px rgba(20,23,28,.08),0 1px 2px rgba(20,23,28,.06),0 24px 56px -22px rgba(20,23,28,.3);display:block}
</style>
<div class="dots"></div>
<div class="brand">${mark}<span>FolioNotes</span></div>
<h1>Local AI notes<br>for your Mac.</h1>
<div class="pill"><b>New in 0.11</b>Meetings and images</div>
<p class="sub">Speakers identified, images described, all on-device.</p>
<img class="win" src="${shot}">`;

const dir = mkdtempSync(join(tmpdir(), "og-"));
const file = join(dir, "og.html");
writeFileSync(file, html);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(file).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(root, "site/assets/og-image.png") });
await browser.close();
