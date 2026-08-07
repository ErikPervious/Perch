#!/usr/bin/env node
/**
 * Bridge: roda como `statusLine` do Claude Code.
 *
 * O Claude Code executa este script a cada render (e a cada `refreshInterval`
 * segundos) e entrega o estado da sessao como JSON no stdin. Aqui a gente:
 *
 *   1. le esse JSON,
 *   2. grava o que interessa em state.json (que a ilha observa),
 *   3. imprime uma statusline bonitinha pro terminal nao ficar vazio.
 *
 * Nada sai da maquina. Nenhuma credencial e lida.
 *
 * Schema relevante do stdin (Claude Code >= 2.1.80):
 *   rate_limits.five_hour  = { used_percentage: 0-100, resets_at: epoch_seconds }
 *   rate_limits.seven_day  = { used_percentage: 0-100, resets_at: epoch_seconds }
 *   context_window         = { used_percentage, remaining_percentage, context_window_size, current_usage }
 *
 * `rate_limits` so aparece para assinantes e apenas depois da primeira resposta
 * da API na sessao -- ate la o campo simplesmente nao existe.
 *
 * Roda tanto sob `node` quanto sob o proprio executavel do app em modo Node
 * (ELECTRON_RUN_AS_NODE), que e como a versao empacotada o invoca -- assim o
 * app nao depende de ter Node instalado na maquina.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Tem que bater com STATE_DIR em src/main/paths.js. Duplicado de proposito: no
// pacote este arquivo mora fora do asar e nao consegue exigir nada de src/.
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Perch');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const MAX_SAMPLES = 240; // ~ historico suficiente pra sparkline e burn rate
const STDIN_TIMEOUT_MS = 2500;

// --- entrada --------------------------------------------------------------

/**
 * Le o stdin por eventos, que funciona igual sob qualquer forma de invocacao
 * (pipe, redirect de arquivo, `node` direto ou o executavel em modo Node).
 *
 * O timeout existe pra que uma invocacao sem stdin nunca segure o terminal:
 * na pior hipotese sai sem payload, nao travado.
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(chunks.join(''));
    };

    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.on('close', finish);
    } catch {
      finish();
    }
  });
}

// --- helpers --------------------------------------------------------------

function readState() {
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8');
    // BOM quebra o JSON.parse. Vale a guarda: qualquer editor no Windows poe.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { version: 1, sessions: {}, samples: [] };
  }
}

/** Grava atomico: tmp + rename. Evita a ilha ler um JSON pela metade. */
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickLimit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const used = num(raw.used_percentage);
  const resets = num(raw.resets_at);
  if (used === null) return null;
  return { used, resetsAt: resets };
}

// --- saida no terminal ----------------------------------------------------

const ANSI = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  green: '\x1b[38;5;114m',
  amber: '\x1b[38;5;221m',
  red: '\x1b[38;5;203m',
  sep: '\x1b[2m · \x1b[0m',
};

function tone(pct) {
  if (pct >= 90) return ANSI.red;
  if (pct >= 70) return ANSI.amber;
  return ANSI.green;
}

function untilReset(epochSeconds, now) {
  if (!epochSeconds) return null;
  const mins = Math.round((epochSeconds * 1000 - now) / 60000);
  if (mins <= 0) return 'agora';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}

// --- fluxo principal ------------------------------------------------------

function run(rawInput) {
  let input = {};
  try {
    // BOM no comeco do stdin quebra o JSON.parse, e alguns invocadores poem um
    // (o PowerShell prepende ao escrever no stdin de um executavel nativo).
    // Sem esta guarda a statusline sai vazia e nada explica o porque.
    const text = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput;
    input = JSON.parse(text);
  } catch {
    // Sem payload valido (execucao manual, teste). Nao quebra o terminal.
  }

  const now = Date.now();
  const sessionId = input.session_id || input.sessionId || 'unknown';
  const limits = input.rate_limits || {};
  const fiveHour = pickLimit(limits.five_hour);
  const sevenDay = pickLimit(limits.seven_day);
  const ctx = input.context_window || {};

  const session = {
    id: sessionId,
    updatedAt: now,
    cwd: input.workspace?.current_dir || input.cwd || null,
    project: input.workspace?.project_dir ? path.basename(input.workspace.project_dir) : null,
    model: input.model?.display_name || input.model?.id || null,
    effort: input.effort?.level || null,
    thinking: input.thinking?.enabled ?? null,
    costUsd: num(input.cost?.total_cost_usd),
    durationMs: num(input.cost?.total_duration_ms),
    linesAdded: num(input.cost?.total_lines_added),
    linesRemoved: num(input.cost?.total_lines_removed),
    context: {
      usedPct: num(ctx.used_percentage),
      remainingPct: num(ctx.remaining_percentage),
      windowSize: num(ctx.context_window_size),
      inputTokens: num(ctx.current_usage?.input_tokens),
      outputTokens: num(ctx.current_usage?.output_tokens),
      cacheReadTokens: num(ctx.current_usage?.cache_read_input_tokens),
      cacheWriteTokens: num(ctx.current_usage?.cache_creation_input_tokens),
      exceeds200k: input.exceeds_200k_tokens ?? null,
    },
  };

  // --- merge no state
  const state = readState();
  state.version = 1;
  state.sessions = state.sessions || {};
  state.samples = Array.isArray(state.samples) ? state.samples : [];

  // Invocacao sem payload nao inventa uma sessao "unknown" no estado.
  if (sessionId !== 'unknown') state.sessions[sessionId] = session;

  // Descarta sessoes que nao dao sinal ha mais de 10 min.
  for (const [id, s] of Object.entries(state.sessions)) {
    if (now - (s.updatedAt || 0) > 10 * 60 * 1000) delete state.sessions[id];
  }

  // rate_limits sao da CONTA, nao da sessao: vivem na raiz do state.
  if (fiveHour || sevenDay) {
    const prev = state.limits || {};

    // Reset de janela: o resets_at mudou => bloco novo comecou.
    const windowChanged =
      fiveHour &&
      prev.fiveHour &&
      fiveHour.resetsAt &&
      prev.fiveHour.resetsAt &&
      fiveHour.resetsAt !== prev.fiveHour.resetsAt;

    state.limits = {
      fiveHour: fiveHour || prev.fiveHour || null,
      sevenDay: sevenDay || prev.sevenDay || null,
      updatedAt: now,
      windowChangedAt: windowChanged ? now : prev.windowChangedAt || null,
    };

    // Amostra pro burn rate: a derivada de used_percentage e mais confiavel
    // que somar tokens, porque ja vem ponderada pelo proprio backend.
    if (fiveHour) {
      const last = state.samples[state.samples.length - 1];
      const changed = !last || last.pct !== fiveHour.used || now - last.t > 60_000;
      if (changed) {
        state.samples.push({ t: now, pct: fiveHour.used, w: sevenDay ? sevenDay.used : null });
        if (state.samples.length > MAX_SAMPLES) state.samples = state.samples.slice(-MAX_SAMPLES);
      }
      // Janela nova zera o historico: misturar blocos falseia a projecao.
      if (windowChanged) {
        state.samples = [{ t: now, pct: fiveHour.used, w: sevenDay ? sevenDay.used : null }];
      }
    }
  }

  try {
    writeState(state);
  } catch {
    // Disco cheio / permissao: a statusline nunca deve derrubar o Claude Code.
  }

  // --- linha do terminal
  const parts = [];
  if (session.model) parts.push(`${ANSI.dim}${session.model}${ANSI.reset}`);
  if (session.cwd) parts.push(`${ANSI.dim}${path.basename(session.cwd)}${ANSI.reset}`);
  if (fiveHour) {
    const reset = untilReset(fiveHour.resetsAt, now);
    parts.push(
      `${tone(fiveHour.used)}5h ${fiveHour.used.toFixed(0)}%${ANSI.reset}` +
        (reset ? `${ANSI.dim} ↻${reset}${ANSI.reset}` : ''),
    );
  }
  if (sevenDay) parts.push(`${tone(sevenDay.used)}7d ${sevenDay.used.toFixed(0)}%${ANSI.reset}`);
  if (session.context.usedPct !== null) {
    parts.push(`${ANSI.dim}ctx ${session.context.usedPct.toFixed(0)}%${ANSI.reset}`);
  }

  process.stdout.write(parts.join(ANSI.sep));
}

readStdin()
  .then(run)
  .catch((err) => {
    // Nunca derruba o terminal do Claude Code -- mas tambem nao some sem dizer
    // nada. O stdout e a statusline; o stderr o Claude Code ignora, entao e o
    // lugar certo pra reclamar. Engolir o erro aqui ja custou uma depuracao.
    process.stderr.write(`[perch] bridge falhou: ${err && err.stack ? err.stack : err}\n`);
  });
