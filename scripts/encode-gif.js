#!/usr/bin/env node
/**
 * Converte os frames crus de `record-reel.ps1` num GIF animado.
 *
 *   node scripts/encode-gif.js [pasta] [--scale 0.6] [--every 1]
 *
 * Não há ffmpeg na máquina de desenvolvimento e trazer uma dependência para
 * isso quebraria o "zero dependências" — então o codificador é escrito aqui,
 * no mesmo espírito dos encoders de PNG e ICO em src/main/icon.js.
 *
 * A paleta é o ponto delicado: GIF só aceita 256 cores. A ilha ajuda, porque é
 * quase toda preta com poucos verdes; um octree simplificado sobre as cores
 * mais frequentes dá resultado limpo sem dithering.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- entrada

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || path.join(process.env.TEMP || '.', 'perch-reel');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const SCALE = flag('scale', 0.6);
const EVERY = flag('every', 1); // pula frames para reduzir peso
// Aparar por índice de frame: a gravação é generosa de propósito, porque o
// tempo de boot do app varia e não dá pra cravar onde a coreografia começa.
const FROM = flag('from', 0);
const TO = flag('to', Infinity);

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

// Lê frame a frame em vez de carregar o arquivo inteiro: a 60fps a gravação
// passa de 2 GiB, que é o teto de um Buffer do Node.
const rawPath = path.join(dir, 'frames.raw');
const rawSize = fs.statSync(rawPath).size;
const rawFd = fs.openSync(rawPath, 'r');

const srcW = meta.width;
const srcH = meta.height;
const outW = Math.round(srcW * SCALE) & ~1;
const outH = Math.round(srcH * SCALE) & ~1;
const frameBytes = srcW * srcH * 4;

// ------------------------------------------------------ redimensionamento

/** Média em caixa: suaviza e evita serrilhado ao reduzir. */
function downscale(frame) {
  const out = Buffer.alloc(outW * outH * 3);
  const fx = srcW / outW;
  const fy = srcH / outH;

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(srcH, Math.ceil((y + 1) * fy));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(srcW, Math.ceil((x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * srcW + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          b += frame[i];
          g += frame[i + 1];
          r += frame[i + 2];
          n += 1;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = (r / n) | 0;
      out[o + 1] = (g / n) | 0;
      out[o + 2] = (b / n) | 0;
    }
  }
  return out;
}

// -------------------------------------------------------------- paleta

/**
 * Conta cores em grade grossa (5 bits por canal) e fica com as 256 mais
 * frequentes. Funciona bem aqui porque a cena é quase toda preta com poucos
 * tons de verde — não é um quantizador de uso geral.
 */
function buildPalette(frames) {
  const counts = new Map();
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 3) {
      const key = ((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256);
  const palette = top.map(([key]) => [((key >> 10) & 31) << 3, ((key >> 5) & 31) << 3, (key & 31) << 3]);
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette;
}

function nearest(palette, r, g, b, cache) {
  const key = (r << 16) | (g << 8) | b;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  cache.set(key, best);
  return best;
}

// ----------------------------------------------------------------- LZW

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();

  const out = [];
  let cur = 0;
  let bits = 0;

  const emit = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      bits -= 8;
    }
  };

  emit(clear);
  let prefix = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    dict.set(key, next);
    next += 1;
    if (next > (1 << codeSize) && codeSize < 12) codeSize += 1;
    if (next >= 4096) {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }

  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 0xff);
  return Buffer.from(out);
}

/** Os dados de imagem do GIF vão em sub-blocos de no máximo 255 bytes. */
function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// --------------------------------------------------------------- fluxo

const total = Math.floor(rawSize / frameBytes);
const last = Math.min(total, TO);
const picked = [];
for (let i = Math.max(0, FROM); i < last; i += EVERY) picked.push(i);

process.stdout.write(
  `${total} frames de ${srcW}x${srcH} -> ${picked.length} de ${outW}x${outH} (${FROM}..${last === total ? 'fim' : last})\n`,
);

const oneFrame = Buffer.alloc(frameBytes);
const scaled = picked.map((i) => {
  fs.readSync(rawFd, oneFrame, 0, frameBytes, i * frameBytes);
  return downscale(oneFrame);
});
fs.closeSync(rawFd);
const palette = buildPalette(scaled);
const cache = new Map();

const header = Buffer.alloc(13);
header.write('GIF89a', 0, 'ascii');
header.writeUInt16LE(outW, 6);
header.writeUInt16LE(outH, 8);
header[10] = 0xf7; // tabela global de cores, 256 entradas
header[11] = 0;
header[12] = 0;

const table = Buffer.alloc(768);
palette.forEach((c, i) => {
  table[i * 3] = c[0];
  table[i * 3 + 1] = c[1];
  table[i * 3 + 2] = c[2];
});

// Loop infinito (extensão da Netscape).
const loop = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]);

const delay = Math.max(2, Math.round(100 / (meta.fps / EVERY))); // centésimos
const chunks = [header, table, loop];

scaled.forEach((frame, n) => {
  const indices = Buffer.alloc(outW * outH);
  for (let p = 0, i = 0; p < indices.length; p++, i += 3) {
    indices[p] = nearest(palette, frame[i], frame[i + 1], frame[i + 2], cache);
  }

  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00]);
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(0, 1);
  desc.writeUInt16LE(0, 3);
  desc.writeUInt16LE(outW, 5);
  desc.writeUInt16LE(outH, 7);
  desc[9] = 0;

  chunks.push(gce, desc, Buffer.from([8]), subBlocks(lzw(indices, 8)));
  if ((n + 1) % 40 === 0) process.stdout.write(`  ${n + 1}/${scaled.length}\n`);
});

chunks.push(Buffer.from([0x3b]));

const gif = Buffer.concat(chunks);
const out = path.join(dir, 'perch.gif');
fs.writeFileSync(out, gif);
process.stdout.write(`\n${out}\n${(gif.length / 1024 / 1024).toFixed(1)} MB · ${delay * 10}ms por frame\n`);

// zlib é só para reportar quanto do peso é redundância entre frames.
void zlib;
