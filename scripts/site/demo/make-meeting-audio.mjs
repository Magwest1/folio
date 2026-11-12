// Builds a fictional three-voice design sync with macOS `say` (synthetic speech only) for the
// transcription screenshots, then encodes it to M4A.
//   node scripts/site/demo/make-meeting-audio.mjs [--out meeting.m4a]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RATE = 16000
export const lines = [
  ['Samantha', "Okay, let's start the Lumen design sync. The usability test showed that four out of five people finished the onboarding checklist without help."],
  ['Daniel', "That is a big improvement. What happened with the invite step?"],
  ['Samantha', "Two people missed it because it sits below the fold, so we will move it higher in the next prototype."],
  ['Rishi', "I can estimate the analytics changes for step tracking by Friday."],
  ['Daniel', "Great. We also agreed to call the new area team space instead of workspace."],
  ['Samantha', "Yes. Tomas will update the prototype, and we will rerun the test with three users next Tuesday."],
  ['Daniel', "Perfect. I will share the highlights reel with the whole team this afternoon."],
  ['Rishi', "Sounds good to me. Let's wrap up there."],
]

function pcmOf(wavFile) {
  const buf = fs.readFileSync(wavFile)
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4)
    if (id === 'data') return buf.subarray(pos + 8, pos + 8 + size)
    pos += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${wavFile}`)
}
function wavOf(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export function buildMeeting(outM4a, { pauseSeconds = 0.9 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-meeting-'))
  const silence = Buffer.alloc(Math.round(RATE * pauseSeconds) * 2)
  const parts = [silence]
  lines.forEach(([voice, text], i) => {
    const f = path.join(tmp, `${i}.wav`)
    execFileSync('say', ['-v', voice, '-r', '175', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', f, text])
    parts.push(pcmOf(f), silence)
  })
  const wav = path.join(tmp, 'meeting.wav')
  fs.writeFileSync(wav, wavOf(Buffer.concat(parts)))
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', wav, outM4a])
  fs.rmSync(tmp, { recursive: true, force: true })
  return outM4a
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out')
  console.log(buildMeeting(i > -1 ? process.argv[i + 1] : path.join(process.env.TMPDIR || '/tmp', 'lumen-design-sync.m4a')))
}
