'use strict';

/**
 * Live Activity.
 *
 * Os transcripts em ~/.claude/projects/**\/*.jsonl sao escritos *enquanto* o
 * Claude responde. Acompanhando o final desses arquivos a ilha sabe, em tempo
 * real, que ha uma sessao gerando agora -- que modelo, que projeto, quantos
 * tokens acabaram de sair. E isso que da o waveform.
 *
 * Este arquivo roda no processo PRINCIPAL, que e o mesmo que coordena a
 * composicao da janela. Qualquer I/O sincrono aqui vira frame perdido na
 * animacao. Dai as tres regras que a estrutura abaixo respeita:
 *
 *   1. Nada de `readFileSync` em arquivo grande -- ha transcripts de 15MB.
 *   2. A varredura completa (~800 arquivos) e rara e assincrona; o tique de
 *      1,2s so olha o punhado de arquivos que esta quente.
 *   3. Trabalho longo cede o event loop a cada lote, com `setImmediate`.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { PROJECTS_DIR } = require('./paths');

const SCAN_MS = 1200; // tique rapido: so os arquivos quentes
const INDEX_MS = 10_000; // varredura completa do diretorio
const ACTIVE_WINDOW_MS = 6000; // sem escrita ha 6s => parou de gerar
const HOT_FILE_MS = 20 * 60 * 1000; // o que conta como "quente"
const HISTORY_DAYS = 7;
const MAX_READ_BYTES = 2 * 1024 * 1024; // teto por leitura, contra surtos
const HISTORY_CHUNK = 1500; // linhas por lote antes de ceder o event loop

/** Peso aproximado de cada tipo de token no consumo de cota. */
function weigh(usage) {
  if (!usage) return 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  // Leitura de cache custa uma fracao; saida custa varias vezes a entrada.
  return input + write * 1.25 + read * 0.1 + output * 5;
}

/** Devolve o event loop por um tique. */
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

async function listTranscripts(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listTranscripts(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** Nome legivel do projeto a partir da pasta C--Projects-foo. */
function projectName(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const slug = rel.split(path.sep)[0] || '';
  const parts = slug.split('-').filter(Boolean);
  return parts[parts.length - 1] || slug;
}

/** Extrai os eventos de uso de um pedaco de JSONL. */
function parseUsageLines(text, file, fallbackTime) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // linha parcial: o resto chega no proximo scan
    }
    const usage = obj?.message?.usage;
    if (!usage) continue;
    events.push({
      t: obj.timestamp ? Date.parse(obj.timestamp) : fallbackTime,
      weighted: weigh(usage),
      output: usage.output_tokens || 0,
      model: obj.message?.model || null,
      project: projectName(file),
    });
  }
  return events;
}

class TranscriptWatcher extends EventEmitter {
  constructor() {
    super();
    this.offsets = new Map(); // arquivo -> bytes ja lidos
    this.hot = []; // arquivos mexidos recentemente
    this.lastEvents = [];
    this.history = [];
    this._scanTimer = null;
    this._indexTimer = null;
    this._indexing = false;
    this._scanning = false;
  }

  async start() {
    await this.refreshIndex(true);
    this._scanTimer = setInterval(() => this.scan(), SCAN_MS);
    this._indexTimer = setInterval(() => this.refreshIndex(false), INDEX_MS);
    // A varredura historica e cara: so depois que a janela ja abriu e animou.
    setTimeout(() => this.buildHistory(), 2500);
  }

  stop() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    if (this._indexTimer) clearInterval(this._indexTimer);
  }

  /**
   * Varredura completa, rara e assincrona. Produz a lista de arquivos quentes
   * que o tique rapido vai vigiar. Na primeira vez tambem ancora os offsets no
   * tamanho atual, pra so reagir ao que for escrito daqui pra frente.
   */
  async refreshIndex(seed) {
    if (this._indexing) return;
    this._indexing = true;
    try {
      const files = await listTranscripts(PROJECTS_DIR);
      const now = Date.now();
      const hot = [];
      let processed = 0;

      for (const file of files) {
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        if (seed && !this.offsets.has(file)) this.offsets.set(file, stat.size);
        if (now - stat.mtimeMs <= HOT_FILE_MS) hot.push(file);
        else if (!seed) this.offsets.set(file, stat.size); // esfriou: reancora

        if (++processed % 120 === 0) await yieldLoop();
      }

      this.hot = hot;
      // Esquece arquivos que sumiram, pra o Map nao crescer pra sempre.
      if (this.offsets.size > files.length * 2) {
        const known = new Set(files);
        for (const file of this.offsets.keys()) if (!known.has(file)) this.offsets.delete(file);
      }
    } finally {
      this._indexing = false;
    }
  }

  /** Tique rapido: le so o que foi anexado nos arquivos quentes. */
  async scan() {
    if (this._scanning) return;
    this._scanning = true;
    const now = Date.now();
    const fresh = [];

    try {
      for (const file of this.hot) {
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }

        const prev = this.offsets.get(file);
        if (prev === undefined) {
          this.offsets.set(file, stat.size);
          continue;
        }
        if (stat.size <= prev) {
          if (stat.size < prev) this.offsets.set(file, stat.size); // truncado
          continue;
        }

        const start = Math.max(prev, stat.size - MAX_READ_BYTES);
        let chunk = '';
        try {
          const handle = await fsp.open(file, 'r');
          try {
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            await handle.read(buf, 0, len, start);
            chunk = buf.toString('utf8');
          } finally {
            await handle.close();
          }
        } catch {
          continue;
        }
        this.offsets.set(file, stat.size);
        fresh.push(...parseUsageLines(chunk, file, now));
      }
    } finally {
      this._scanning = false;
    }

    if (fresh.length) {
      this.lastEvents.push(...fresh);
      this.lastEvents = this.lastEvents.filter((e) => now - e.t < 120_000).slice(-400);
    }

    const recent = this.lastEvents.filter((e) => now - e.t < ACTIVE_WINDOW_MS);
    const active = recent.length > 0;
    const outputPerSec = recent.reduce((sum, e) => sum + e.output, 0) / (ACTIVE_WINDOW_MS / 1000);

    this.emit('activity', {
      active,
      // Intensidade 0..1 pro waveform: ~200 tokens/s ja e "a todo vapor".
      intensity: Math.max(0, Math.min(1, outputPerSec / 200)),
      model: recent.length ? recent[recent.length - 1].model : null,
      project: recent.length ? recent[recent.length - 1].project : null,
      burstTokens: recent.reduce((sum, e) => sum + e.output, 0),
    });
  }

  /**
   * Agrega os ultimos dias pro grafico do painel expandido.
   *
   * Sao dezenas de arquivos, um deles com 15MB. Lido de uma vez isso trava o
   * processo principal por segundos e a animacao engasga. Por isso: leitura
   * assincrona, e o parse cede o event loop a cada lote de linhas.
   */
  async buildHistory() {
    const cutoff = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
    const byDay = new Map();
    const files = await listTranscripts(PROJECTS_DIR);

    for (const file of files) {
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;

      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += HISTORY_CHUNK) {
        for (const line of lines.slice(i, i + HISTORY_CHUNK)) {
          if (!line.includes('"usage"')) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          const usage = obj?.message?.usage;
          if (!usage || !obj.timestamp) continue;
          const t = Date.parse(obj.timestamp);
          if (t < cutoff) continue;

          const day = new Date(t).toISOString().slice(0, 10);
          const bucket = byDay.get(day) || { date: day, weighted: 0, messages: 0, byModel: {} };
          const w = weigh(usage);
          bucket.weighted += w;
          bucket.messages += 1;
          const model = obj.message?.model || 'desconhecido';
          bucket.byModel[model] = (bucket.byModel[model] || 0) + w;
          byDay.set(day, bucket);
        }
        await yieldLoop();
      }
    }

    this.history = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    this.emit('history', this.history);
  }
}

module.exports = { TranscriptWatcher };
