#!/usr/bin/env node
/**
 * Verificação que o CI roda, e que você pode rodar antes de abrir um PR:
 *
 *   node scripts/check.js
 *
 * Faz duas coisas.
 *
 * 1. **Sintaxe** de todo JS do projeto. Os módulos do renderer são ESM e o
 *    `node --check` os trata como CommonJS, então eles são copiados para .mjs
 *    antes — é o mesmo truque descrito no CONTRIBUTING, só que automatizado.
 *
 * 2. **Invariantes de pares.** Há valores duplicados de propósito em arquivos
 *    diferentes que precisam continuar batendo. Nada no runtime reclama quando
 *    eles divergem: o bicho só passa a olhar torto, ou o bridge grava numa
 *    pasta que a ilha não lê. O CLAUDE.md documenta cada um; aqui eles viram
 *    falha de build.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
const fail = (what, detail) => {
  failures += 1;
  console.log(`  ✗ ${what}`);
  if (detail) console.log(`      ${detail}`);
};
const pass = (what) => console.log(`  ✓ ${what}`);

// ------------------------------------------------------------------ sintaxe

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

console.log('sintaxe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-check-'));
let checked = 0;

for (const file of collect(ROOT)) {
  const source = fs.readFileSync(file, 'utf8');
  // Módulo ES: import/export no início de alguma linha.
  const isModule = /^\s*(import|export)[\s{*]/m.test(source);

  let target = file;
  if (isModule) {
    target = path.join(tmp, `${path.basename(file, '.js')}.mjs`);
    fs.writeFileSync(target, source);
  }

  const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(path.relative(ROOT, file), (result.stderr || '').split('\n').slice(0, 3).join(' ').trim());
  }
  checked += 1;
}
fs.rmSync(tmp, { recursive: true, force: true });
if (!failures) pass(`${checked} arquivos`);

// -------------------------------------------------------------- invariantes

console.log('\ninvariantes');

// O SVG do bicho é 48x48 e o elemento em CSS também, para que 1 unidade de
// viewBox seja 1 pixel. Se os olhos saírem do lugar no markup sem que as
// constantes acompanhem, o cálculo do olhar aponta para o vazio.
{
  const critter = read('src/renderer/critter.js');
  const html = read('src/renderer/index.html');
  const num = (re, text) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };

  const cy = num(/EYE_CY\s*=\s*([\d.]+)/, critter);
  const rx = num(/EYE_RX\s*=\s*([\d.]+)/, critter);
  const ry = num(/EYE_RY\s*=\s*([\d.]+)/, critter);

  const eyes = [...html.matchAll(/class="critter__white"[^>]*cy="([\d.]+)"\s+rx="([\d.]+)"\s+ry="([\d.]+)"/g)];
  if (!eyes.length) {
    fail('olhos do bicho encontrados no index.html');
  } else {
    const mismatch = eyes.find((m) => Number(m[1]) !== cy || Number(m[2]) !== rx || Number(m[3]) !== ry);
    if (mismatch) {
      fail(
        'geometria dos olhos bate entre critter.js e index.html',
        `js: cy=${cy} rx=${rx} ry=${ry} · html: cy=${mismatch[1]} rx=${mismatch[2]} ry=${mismatch[3]}`,
      );
    } else {
      pass(`geometria dos olhos (cy=${cy} rx=${rx} ry=${ry}) em ${eyes.length} olhos`);
    }
  }

  // A âncora do olhar é calculada em JS; a posição real vem do CSS.
  const offset = num(/CRITTER_OFFSET_X\s*=\s*([\d.]+)/, critter);
  const css = num(/--critter-dx,\s*([\d.]+)px/, read('src/renderer/style.css'));
  if (offset !== css) fail('CRITTER_OFFSET_X bate com --critter-dx', `js: ${offset} · css: ${css}`);
  else pass(`deslocamento do bicho (${offset}px) igual em critter.js e style.css`);
}

// O bridge vai em extraResources, fora do asar, e não pode exigir nada de
// src/. Por isso o STATE_DIR está duplicado — e precisa continuar batendo.
{
  const inBridge = (read('bridge/statusline.js').match(/homedir\(\),\s*'([^']+)'\)/) || [])[1];
  const inPaths = (read('src/main/paths.js').match(/path\.join\(LOCAL,\s*'([^']+)'\)/) || [])[1];
  if (!inBridge || inBridge !== inPaths) fail('STATE_DIR igual no bridge e em paths.js', `bridge: ${inBridge} · paths: ${inPaths}`);
  else pass(`STATE_DIR ("${inBridge}") igual no bridge e em paths.js`);
}

// O README anuncia zero dependências em runtime, e isso é um argumento do
// projeto — não pode virar mentira sem alguém notar.
{
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys(pkg.dependencies || {});
  if (deps.length) fail('nenhuma dependência em runtime', deps.join(', '));
  else pass('nenhuma dependência em runtime');
}

console.log();
if (failures) {
  console.log(`${failures} verificação(ões) falharam`);
  process.exit(1);
}
console.log('tudo certo');
