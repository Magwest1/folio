// Renders a fictional whiteboard photo (checklist wireframe with sticky notes) to PNG for the image description screenshots.
//   node scripts/site/demo/make-sketch-image.mjs [--out file.png]
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outIdx = process.argv.indexOf('--out')
const defaultOut = path.join(process.env.TMPDIR || '/tmp', 'folionotes-demo-sketch.png')
const hand = "'Marker Felt','Bradley Hand','Chalkboard SE',cursive"

const html = `<!doctype html><html><body style="margin:0;width:1600px;height:900px;overflow:hidden;position:relative;font-family:${hand};
background:radial-gradient(ellipse at 30% 25%,#fbfbf8,#ecece6 75%,#dedfd8)">
<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.35),transparent 30%,rgba(0,0,0,.08))"></div>
<div style="position:absolute;left:0;right:0;bottom:0;height:46px;background:linear-gradient(#b9bcc2,#8c9097);box-shadow:0 -4px 10px rgba(0,0,0,.25)"></div>
<svg width="1600" height="900" style="position:absolute;inset:0" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <g transform="rotate(-1.2 800 450)">
    <text x="90" y="120" font-size="64" fill="#1d3f8a" font-family="${hand}">Onboarding checklist</text>
    <path d="M92 138 C 360 150, 560 128, 760 140" stroke="#1d3f8a" stroke-width="6"/>
    <rect x="110" y="190" width="640" height="560" rx="34" stroke="#222" stroke-width="7"/>
    <circle cx="240" cy="300" r="64" stroke="#c9ccd2" stroke-width="16"/>
    <path d="M240 236 A64 64 0 1 1 176 300" stroke="#1f9d55" stroke-width="16"/>
    <text x="214" y="316" font-size="44" fill="#222" font-family="${hand}">2/3</text>
    <text x="340" y="296" font-size="40" fill="#222" font-family="${hand}">Welcome to Lumen</text>
    <text x="340" y="340" font-size="30" fill="#555" font-family="${hand}">Finish your setup</text>
    <rect x="150" y="410" width="48" height="48" rx="8" stroke="#222" stroke-width="6"/>
    <path d="M160 434 L172 447 L192 420" stroke="#1f9d55" stroke-width="8"/>
    <text x="226" y="448" font-size="38" fill="#222" font-family="${hand}">Create your team space</text>
    <rect x="150" y="500" width="48" height="48" rx="8" stroke="#222" stroke-width="6"/>
    <path d="M160 524 L172 537 L192 510" stroke="#1f9d55" stroke-width="8"/>
    <text x="226" y="538" font-size="38" fill="#222" font-family="${hand}">Add your first note</text>
    <rect x="150" y="590" width="48" height="48" rx="8" stroke="#222" stroke-width="6"/>
    <text x="226" y="628" font-size="38" fill="#222" font-family="${hand}">Invite a teammate</text>
    <rect x="150" y="670" width="560" height="52" rx="26" stroke="#1d3f8a" stroke-width="6"/>
    <text x="300" y="707" font-size="32" fill="#1d3f8a" font-family="${hand}">Skip for now</text>
    <path d="M770 610 C 880 600, 930 560, 990 520" stroke="#d2342a" stroke-width="7"/>
    <path d="M960 508 L994 516 L982 548" stroke="#d2342a" stroke-width="7"/>
    <text x="840" y="140" font-size="40" fill="#d2342a" font-family="${hand}">Version B</text>
    <rect x="1000" y="190" width="440" height="330" rx="26" stroke="#222" stroke-width="7"/>
    <rect x="1040" y="240" width="40" height="40" rx="8" stroke="#222" stroke-width="5"/>
    <path d="M1049 260 L1058 270 L1072 250" stroke="#1f9d55" stroke-width="6"/>
    <text x="1100" y="272" font-size="32" fill="#222" font-family="${hand}">Invite a teammate</text>
    <rect x="1040" y="320" width="40" height="40" rx="8" stroke="#222" stroke-width="5"/>
    <text x="1100" y="352" font-size="32" fill="#222" font-family="${hand}">Create team space</text>
    <rect x="1040" y="400" width="40" height="40" rx="8" stroke="#222" stroke-width="5"/>
    <text x="1100" y="432" font-size="32" fill="#222" font-family="${hand}">Add your first note</text>
  </g>
</svg>
<div style="position:absolute;left:1030px;top:580px;width:250px;height:200px;background:#ffe36e;transform:rotate(3deg);box-shadow:4px 8px 14px rgba(0,0,0,.28);padding:22px;box-sizing:border-box;font-size:34px;line-height:1.15;color:#2b2b2b">Invite step moves above the fold!</div>
<div style="position:absolute;left:1310px;top:610px;width:210px;height:180px;background:#ff9fb5;transform:rotate(-4deg);box-shadow:4px 8px 14px rgba(0,0,0,.28);padding:20px;box-sizing:border-box;font-size:30px;line-height:1.15;color:#2b2b2b">Rename workspace to team space</div>
<div style="position:absolute;left:1180px;top:80px;width:220px;height:90px;background:#9fe0ff;transform:rotate(2deg);box-shadow:4px 8px 14px rgba(0,0,0,.28);padding:16px 20px;box-sizing:border-box;font-size:28px;color:#2b2b2b">Test with 3 users</div>
</body></html>`

export async function renderSketch(out) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.setContent(html)
  await page.screenshot({ path: out })
  await browser.close()
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await renderSketch(outIdx > -1 ? process.argv[outIdx + 1] : defaultOut))
