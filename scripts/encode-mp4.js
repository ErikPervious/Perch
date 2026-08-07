#!/usr/bin/env node
/**
 * Converte os frames crus de `record-reel.ps1` num MP4, via ffmpeg.
 *
 *   node scripts/encode-mp4.js [pasta] [--from 0] [--to N] [--crf 17] [--scale 1]
 *
 * Diferente do encode-gif.js, este depende de ffmpeg instalado. Vale a pena
 * para o resultado que se publica: H.264 não tem a paleta de 256 cores do GIF,
 * que arruína degradês e neon.
 *
 * O ffmpeg não entra como dependência do projeto — é ferramenta de quem grava,
 * não do app. O `npm run build` continua sem precisar dele.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || path.join(process.env.TEMP || '.', 'perch-reel');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const CRF = flag('crf', 17); // 17 é praticamente sem perda visível
const SCALE = flag('scale', 1);
const FROM = flag('from', 0);
const TO = flag('to', Infinity);

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const rawPath = path.join(dir, 'frames.raw');
const frameBytes = meta.width * meta.height * 4;
const total = Math.floor(fs.statSync(rawPath).size / frameBytes);
const last = Math.min(total, TO);
const fps = meta.fps;

// O ffmpeg do winget não entra no PATH da sessão atual.
const candidates = [
  'ffmpeg',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
];
const ffmpeg = candidates.find((c) => spawnSync(c, ['-version'], { encoding: 'utf8' }).status === 0);
if (!ffmpeg) {
  process.stderr.write('ffmpeg nao encontrado. Instale com: winget install Gyan.FFmpeg\n');
  process.exit(1);
}

const filters = [
  `trim=start_frame=${Math.max(0, FROM)}:end_frame=${last}`,
  'setpts=PTS-STARTPTS',
];
if (SCALE !== 1) {
  // Par nas duas dimensões: yuv420p exige.
  filters.push(`scale=trunc(iw*${SCALE}/2)*2:trunc(ih*${SCALE}/2)*2:flags=lanczos`);
}
filters.push('format=yuv420p');

const out = path.join(dir, 'perch.mp4');
const argv = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo',
  '-pixel_format', 'bgra',
  '-video_size', `${meta.width}x${meta.height}`,
  '-framerate', String(fps),
  '-i', rawPath,
  '-vf', filters.join(','),
  '-c:v', 'libx264',
  '-crf', String(CRF),
  '-preset', 'slow',
  '-profile:v', 'high',
  // Faz o player começar a exibir sem baixar o arquivo inteiro. O LinkedIn
  // e o GitHub agradecem.
  '-movflags', '+faststart',
  out,
];

process.stdout.write(`${total} frames de ${meta.width}x${meta.height} a ${fps}fps -> ${last - FROM} frames\n`);
const run = spawnSync(ffmpeg, argv, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
if (run.status !== 0) process.exit(run.status || 1);

const size = fs.statSync(out).size;
process.stdout.write(`\n${out}\n${(size / 1024 / 1024).toFixed(1)} MB · ${((last - FROM) / fps).toFixed(1)}s · crf ${CRF}\n`);
