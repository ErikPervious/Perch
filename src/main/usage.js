'use strict';

/**
 * Observa o state.json escrito pelo bridge e deriva as metricas que a ilha usa.
 *
 * O bridge entrega verdade pontual (`used_percentage` vindo do proprio backend).
 * Aqui a gente calcula a *derivada*: velocidade de queima, projecao de esgotamento
 * e anomalia de ritmo -- que e o que permite a ilha avisar ANTES de estourar.
 */

const fs = require('fs');
const { EventEmitter } = require('events');
const { STATE_FILE, STATE_DIR } = require('./paths');

const POLL_MS = 2000;
const REGRESSION_WINDOW_MS = 12 * 60 * 1000; // janela pra estimar o ritmo atual

/** Regressao linear simples: retorna a inclinacao em unidades por minuto. */
function slopePerMinute(samples) {
  if (samples.length < 2) return 0;
  const t0 = samples[0].t;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    const x = (s.t - t0) / 60000;
    const y = s.pct;
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const n = samples.length;
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 0;
  return (n * sxy - sx * sy) / denom;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Ritmo tipico do bloco: mediana das inclinacoes ponto-a-ponto. */
function baselineBurn(samples) {
  const steps = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 60000;
    if (dt <= 0.2) continue; // amostras coladas viram ruido
    steps.push((samples[i].pct - samples[i - 1].pct) / dt);
  }
  return median(steps.filter((v) => v >= 0));
}

/** Reduz N amostras a `buckets` pontos, preservando o formato da curva. */
function downsample(samples, buckets = 48) {
  if (samples.length <= buckets) return samples.map((s) => s.pct);
  const out = [];
  const size = samples.length / buckets;
  for (let i = 0; i < buckets; i++) {
    const chunk = samples.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    if (!chunk.length) continue;
    out.push(chunk[chunk.length - 1].pct);
  }
  return out;
}

class UsageStore extends EventEmitter {
  constructor() {
    super();
    this.raw = null;
    this.lastMtime = 0;
    this.snapshot = this.derive(null);
    this._timer = null;
    this._watcher = null;
  }

  start() {
    this.read(true);
    // Poll e o caminho confiavel: o bridge grava com rename atomico e o
    // fs.watch do Windows perde eventos de rename com alguma frequencia.
    this._timer = setInterval(() => this.read(false), POLL_MS);
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      this._watcher = fs.watch(STATE_DIR, () => this.read(false));
    } catch {
      /* poll cobre */
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._watcher) this._watcher.close();
  }

  read(force) {
    let stat;
    try {
      stat = fs.statSync(STATE_FILE);
    } catch {
      if (force) this.emit('update', this.snapshot);
      return;
    }
    const mtime = stat.mtimeMs;
    if (!force && mtime === this.lastMtime) return;
    this.lastMtime = mtime;

    let parsed;
    try {
      const text = fs.readFileSync(STATE_FILE, 'utf8');
      // BOM quebra o JSON.parse; no Windows ele aparece com facilidade.
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return; // grava atomica, mas se pegar no meio a gente tenta no proximo tick
    }

    this.raw = parsed;
    this.snapshot = this.derive(parsed);
    this.emit('update', this.snapshot);
  }

  derive(state) {
    const now = Date.now();

    if (!state || !state.limits || !state.limits.fiveHour) {
      return {
        ok: false,
        reason: state ? 'sem-rate-limits' : 'sem-bridge',
        now,
        fiveHour: null,
        sevenDay: null,
        sessions: state ? Object.values(state.sessions || {}) : [],
        spark: [],
        burnPerMin: 0,
        baselinePerMin: 0,
        anomalyRatio: 1,
        minutesToLimit: null,
        staleMs: null,
      };
    }

    const { fiveHour, sevenDay, updatedAt, windowChangedAt } = state.limits;
    const samples = Array.isArray(state.samples) ? state.samples : [];

    const recent = samples.filter((s) => now - s.t <= REGRESSION_WINDOW_MS);
    const burnPerMin = Math.max(0, slopePerMinute(recent.length >= 2 ? recent : samples));
    const basePerMin = baselineBurn(samples);

    const remaining = Math.max(0, 100 - fiveHour.used);
    const minutesToLimit = burnPerMin > 0.01 ? remaining / burnPerMin : null;

    const resetInMs = fiveHour.resetsAt ? fiveHour.resetsAt * 1000 - now : null;
    // "Vai estourar antes de renovar?" -- e essa a pergunta que importa.
    const willExhaust =
      minutesToLimit !== null && resetInMs !== null && minutesToLimit * 60000 < resetInMs;

    return {
      ok: true,
      now,
      fiveHour: {
        used: fiveHour.used,
        resetsAt: fiveHour.resetsAt,
        resetInMs,
      },
      sevenDay: sevenDay
        ? { used: sevenDay.used, resetsAt: sevenDay.resetsAt, resetInMs: sevenDay.resetsAt ? sevenDay.resetsAt * 1000 - now : null }
        : null,
      sessions: Object.values(state.sessions || {}).sort((a, b) => b.updatedAt - a.updatedAt),
      spark: downsample(samples),
      sampleCount: samples.length,
      burnPerMin,
      baselinePerMin: basePerMin,
      anomalyRatio: basePerMin > 0.01 ? burnPerMin / basePerMin : 1,
      minutesToLimit,
      willExhaust,
      windowChangedAt: windowChangedAt || null,
      staleMs: updatedAt ? now - updatedAt : null,
    };
  }
}

module.exports = { UsageStore };
