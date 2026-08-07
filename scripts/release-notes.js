#!/usr/bin/env node
/**
 * Extrai do CHANGELOG.md a seção de uma versão e imprime no stdout.
 *
 *   node scripts/release-notes.js v1.0.1
 *
 * O CI usa isto para montar as notas da release. Uma fonte só alimenta três
 * destinos: o arquivo no repositório, a página da release e o painel do app,
 * que busca essas mesmas notas pela API do GitHub.
 *
 * Falha com código 1 se a versão não estiver no changelog — é de propósito.
 * Publicar uma release sem registrar o que mudou é o tipo de coisa que só se
 * descobre depois, quando alguém pergunta.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const raw = process.argv[2];
if (!raw) {
  process.stderr.write('uso: node scripts/release-notes.js <versao>\n');
  process.exit(2);
}

const version = raw.replace(/^v/, '');
const file = path.join(__dirname, '..', 'CHANGELOG.md');

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch {
  process.stderr.write(`nao consegui ler ${file}\n`);
  process.exit(2);
}

const lines = text.replace(/\r\n/g, '\n').split('\n');

// Cabeçalhos de versão: "## [1.0.0] — 2026-08-07" ou "## [1.0.0]".
const isHeading = (line) => /^##\s+\[/.test(line);
const headingVersion = (line) => (line.match(/^##\s+\[([^\]]+)\]/) || [])[1];

const start = lines.findIndex((l) => isHeading(l) && headingVersion(l) === version);
if (start === -1) {
  process.stderr.write(`versao ${version} nao encontrada no CHANGELOG.md\n`);
  process.stderr.write('   adicione a seção antes de criar a tag\n');
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (isHeading(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  // Referências de link no rodapé não interessam nas notas.
  .filter((l) => !/^\[[^\]]+\]:\s+https?:/.test(l))
  .join('\n')
  .trim();

if (!body) {
  process.stderr.write(`a seção da versao ${version} esta vazia\n`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
