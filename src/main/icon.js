'use strict';

/**
 * Gera o icone da bandeja em memoria (PNG puro, sem dependencia externa):
 * uma pilula clara com um ponto colorido no meio, que muda de cor conforme
 * o nivel de uso.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distancia com sinal ate a borda de um retangulo arredondado. */
function pillSDF(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

function blend(rgba, i, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  rgba[i] = Math.round(rgba[i] * (1 - a) + r * a);
  rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + g * a);
  rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + b * a);
  rgba[i + 3] = Math.max(rgba[i + 3], Math.round(255 * a));
}

const TONES = {
  good: [48, 209, 88],
  info: [110, 190, 255],
  warning: [255, 214, 10],
  critical: [255, 69, 58],
  idle: [140, 145, 155],
};

/** PNG 32x32 da bandeja. `tone` vem de TONES. */
function trayIcon(tone = 'idle') {
  const size = 32;
  const rgba = Buffer.alloc(size * size * 4, 0);
  const shell = [232, 234, 240];
  const dot = TONES[tone] || TONES.idle;

  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const halfW = 12.5;
  const halfH = 6.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = pillSDF(x, y, cx, cy, halfW, halfH, 6.5);
      // Contorno da pilula: banda de ~1.6px ao redor de d = 0.
      const ring = Math.max(0, 1 - Math.abs(d + 0.8) / 1.1);
      blend(rgba, i, shell, ring);
      // Ponto central.
      const dotDist = Math.hypot(x - cx, y - cy) - 3.2;
      blend(rgba, i, dot, Math.max(0, Math.min(1, 0.5 - dotDist)));
    }
  }

  return encodePNG(size, size, rgba);
}

/**
 * Icone do aplicativo: quadrado arredondado escuro com a ilha dentro.
 * Serve pro .ico do instalador e pro atalho no menu iniciar.
 */
function appIcon(size = 256) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const k = size / 256; // tudo abaixo esta em unidades de 256px

  const plate = [17, 18, 21];
  const pill = [246, 247, 250];
  const dot = TONES.good;

  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Fundo: quadrado de cantos generosos, no espirito do resto do app.
      const plateD = pillSDF(x, y, cx, cy, 122 * k, 122 * k, 56 * k);
      blend(rgba, i, plate, Math.max(0, Math.min(1, 0.5 - plateD)));

      // Fio de luz na borda de cima do fundo.
      const rim = Math.max(0, 1 - Math.abs(plateD + 1.4 * k) / (1.4 * k));
      if (y < cy) blend(rgba, i, [255, 255, 255], rim * 0.16);

      // A ilha.
      const pillD = pillSDF(x, y, cx, cy - 6 * k, 74 * k, 26 * k, 26 * k);
      blend(rgba, i, pill, Math.max(0, Math.min(1, 0.5 - pillD)));

      // O ponto de status.
      const dotD = Math.hypot(x - (cx - 40 * k), y - (cy - 6 * k)) - 11 * k;
      blend(rgba, i, dot, Math.max(0, Math.min(1, 0.5 - dotD)));
    }
  }

  return encodePNG(size, size, rgba);
}

/**
 * Empacota varios PNGs num .ico.
 *
 * O formato e so um indice seguido dos bytes das imagens -- e o Windows aceita
 * PNG dentro do .ico desde o Vista, entao da pra reaproveitar o encoder acima
 * em vez de escrever um codificador BMP.
 */
function icoFile(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const images = sizes.map((size) => ({ size, png: appIcon(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // 1 = icone
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * 16;
    directory[at] = image.size >= 256 ? 0 : image.size; // 0 significa 256
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // paleta
    directory[at + 3] = 0; // reservado
    directory.writeUInt16LE(1, at + 4); // planos
    directory.writeUInt16LE(32, at + 6); // bits por pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

module.exports = { trayIcon, appIcon, icoFile, TONES };
