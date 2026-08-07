#!/usr/bin/env node
/**
 * Gera build/icon.ico a partir do desenho em src/main/icon.js.
 *
 * O icone e codigo, nao um binario solto no repositorio: mudar a cor ou o raio
 * e editar uma linha e rodar de novo. Roda automaticamente antes do build.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { icoFile, appIcon } = require('../src/main/icon');

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const ico = icoFile();
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

// PNG de 512 tambem: util pra atalho, README e qualquer outra superficie.
fs.writeFileSync(path.join(outDir, 'icon.png'), appIcon(512));

console.log(`  ✓ build/icon.ico  (${(ico.length / 1024).toFixed(1)} KB, 7 tamanhos)`);
console.log('  ✓ build/icon.png  (512px)');
