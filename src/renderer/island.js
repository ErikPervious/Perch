'use strict';

import { Spring, Shake, PRESETS, mixHex } from './spring.js';
import { Critter, CRITTER_OFFSET_X } from './critter.js';

/* =========================================================================
   Geometria de cada estado. A janela nunca muda de tamanho -- esses numeros
   viram CSS vars e as molas cuidam do caminho entre eles.
   ========================================================================= */

const GEOM = {
  hidden: { w: 176, h: 36, r: 18, y: -96, o: 0 },
  pill: { w: 152, h: 30, r: 15, y: 8, o: 1 },
  // A barra pode ser larga a vontade: e uma regua, nao um card. Quanto mais
  // comprida, mais resolucao tem cada ponto percentual.
  bar: { w: 540, h: 30, r: 15, y: 9, o: 1 },
  expanded: { w: 404, h: 122, r: 30, y: 10, o: 1 },
  detail: { w: 452, h: 296, r: 34, y: 10, o: 1 },
  alert: { w: 372, h: 96, r: 26, y: 10, o: 1 },
  setup: { w: 340, h: 74, r: 23, y: 10, o: 1 },
};

/** Formatos que tem altura sobrando pra engrenagem no canto. */
const GEAR_STATES = new Set(['expanded', 'detail']);

/** O que o atalho abre, conforme a configuracao. */
const FORMAT_STATE = { card: 'expanded', bar: 'bar', pill: 'pill' };

const HOVER_ENTER_PAD = 6;
const HOVER_LEAVE_PAD = 24; // histerese: sair exige mais que entrar, senao pisca

const $ = (sel) => document.querySelector(sel);
const role = (name) => document.querySelector(`[data-role="${name}"]`);

const el = {
  stage: $('#stage'),
  goo: $('#goo'),
  bubble: $('#bubble'),
  layers: [...document.querySelectorAll('.layer')],
};

const critter = new Critter($('#critter'));
let lastActiveAt = 0;

// Erro no renderer sem devtools aberto some sem deixar rastro. O main repassa
// o console pro stderr nos modos de teste, entao aqui basta gritar.
window.addEventListener('error', (e) => console.error(`[erro] ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => console.error(`[promise] ${e.reason}`));

/* ----------------------------------------------------------------- molas */

const geo = {
  w: new Spring(GEOM.hidden.w),
  h: new Spring(GEOM.hidden.h),
  r: new Spring(GEOM.hidden.r),
  y: new Spring(GEOM.hidden.y),
  o: new Spring(0),
  glow: new Spring(0),
  level: new Spring(0), // porcentagem suavizada, so pra cor nao pular
};

const bubble = {
  x: new Spring(-70),
  y: new Spring(16),
  s: new Spring(0.35),
  o: new Spring(0),
};

const shake = new Shake();

/* ----------------------------------------------------------------- estado */

let baseState = 'hidden'; // o que a ilha mostra quando ninguem esta com o mouse em cima
let effective = 'hidden';
let hovering = false;
let pinned = false; // clique trava aberta
let interactive = false;
let alertTimer = null;
let currentAlert = null;
let ready = false; // vira true quando o preaquecimento termina
let pendingState = null; // estado pedido durante o preaquecimento

let snapshot = null;
let activity = { active: false, intensity: 0 };
let config = { idleVisible: false, liveActivity: true };

/* ------------------------------------------------------------------ cores */

function toneFor(pct) {
  if (pct == null) return '#8c919b';
  if (pct < 45) return '#30d158';
  if (pct < 75) return mixHex('#30d158', '#ffd60a', (pct - 45) / 30);
  return mixHex('#ffd60a', '#ff453a', Math.min(1, (pct - 75) / 20));
}

const ALERT_TONE = {
  good: '#30d158',
  info: '#6ebeff',
  warning: '#ffd60a',
  critical: '#ff453a',
};

/* -------------------------------------------------------------- transicao */

function idleState() {
  if (snapshot && snapshot.bridge && !snapshot.bridge.installed) return 'setup';
  return config.idleVisible ? 'pill' : 'hidden';
}

/** Estado que o atalho abre: card, barra ou pilula. */
function openState() {
  return FORMAT_STATE[config.format] || 'expanded';
}

function resolve() {
  if (pinned) return 'detail';
  if (hovering && baseState !== 'hidden') return 'detail';
  return baseState;
}

function applyState(next) {
  // Durante o preaquecimento a geometria esta sendo usada como bancada de
  // teste. Guarda o pedido e aplica quando terminar.
  if (!ready) {
    pendingState = next;
    return;
  }
  if (next === effective) return;
  const previous = effective;
  effective = next;

  const target = GEOM[next] || GEOM.hidden;
  const from = GEOM[previous] || GEOM.hidden;

  // Crescer e encolher pedem molas diferentes: abrir pode quicar, fechar nao.
  const leaving = previous === 'hidden';
  const entering = next === 'hidden';
  const growing = target.w * target.h > from.w * from.h;

  let preset;
  if (leaving) preset = PRESETS.drop;
  else if (entering) preset = PRESETS.retract;
  else preset = growing ? PRESETS.grow : PRESETS.shrink;

  geo.w.to(target.w, preset);
  geo.h.to(target.h, preset);
  geo.r.to(target.r, preset);
  geo.y.to(target.y, leaving ? PRESETS.drop : entering ? PRESETS.retract : PRESETS.smooth);
  geo.o.to(target.o, PRESETS.snappy);

  for (const layer of el.layers) {
    layer.classList.toggle('is-active', layer.dataset.layer === next);
  }
  $('#content').classList.toggle('can-gear', GEAR_STATES.has(next));

  // O bicho esta agarrado na ilha: se ela muda de tamanho, ele leva o tranco.
  // Crescer empurra pra fora, encolher puxa de volta -- proporcional ao quanto
  // a largura mudou, entao um morph pequeno mal balanca.
  const delta = (target.w - from.w) / 100;
  critter.nudge(Math.max(-34, Math.min(34, delta * 22)));

  // Rastrear o cursor pela tela toda so faz sentido com algo visivel -- a
  // ilha, ou o bicho espiando por conta propria.
  if ((previous === 'hidden') !== (next === 'hidden')) {
    syncTracking();
  }
  critter.setPeeking(next !== 'hidden' || (config.critter !== false && config.critterAuto));

  if (next === 'hidden') window.island.requestHide();
}

function setBase(next) {
  baseState = next;
  applyState(resolve());
}

/** O main so gasta CPU lendo o cursor quando ha algo na tela pra reagir. */
function syncTracking() {
  const critterOut = config.critter !== false && config.critterAuto;
  window.island.setTracking(effective !== 'hidden' || critterOut);
}

/* -------------------------------------------------------------- alertas */

function fireAlert(alert, peekMs) {
  currentAlert = alert;
  clearTimeout(alertTimer);

  role('alert-title').textContent = alert.title;
  role('alert-detail').textContent = alert.detail;
  role('alert-bar').style.width = `${Math.min(100, alert.value || 0)}%`;

  const tone = ALERT_TONE[alert.level] || '#6ebeff';
  document.documentElement.style.setProperty('--tone', tone);
  geo.glow.to(alert.level === 'critical' ? 1 : 0.72, PRESETS.smooth);

  setBase('alert');
  playBubble();
  if (alert.shake) shake.fire(alert.level === 'critical' ? 9 : 6);

  alertTimer = setTimeout(() => {
    if (hovering || pinned) return; // nao foge enquanto voce esta lendo
    currentAlert = null;
    setBase(idleState());
  }, peekMs || 4200);
}

/** A bolha que se solta e se funde no corpo -- so aparece nos alertas. */
function playBubble() {
  el.goo.classList.add('is-gooing');
  bubble.x.jump(-78);
  bubble.y.jump(20);
  bubble.s.jump(0.3);
  bubble.o.jump(0);

  bubble.o.to(1, PRESETS.snappy);
  bubble.s.to(1, PRESETS.grow);
  bubble.x.to(0, PRESETS.grow);
  bubble.y.to(GEOM.alert.h / 2 - 9 + GEOM.alert.y, PRESETS.grow);

  setTimeout(() => bubble.o.to(0, PRESETS.smooth), 320);
  setTimeout(() => el.goo.classList.remove('is-gooing'), 900);
}

/* ------------------------------------------------------------- waveform */

const waveBars = [...document.querySelectorAll('.wave i')];
const wavePhase = waveBars.map((_, i) => i * 1.15);

function stepWave(t) {
  const on = activity.active && config.liveActivity;
  const intensity = on ? 0.25 + activity.intensity * 0.75 : 0;
  waveBars.forEach((bar, i) => {
    const wobble = 0.5 + 0.5 * Math.sin(t * 7 + wavePhase[i % 5] + Math.sin(t * 2.3 + i) * 0.6);
    const height = 3 + wobble * intensity * 13;
    bar.style.height = `${height.toFixed(1)}px`;
  });

  for (const wave of [role('wave'), role('wave-2')]) {
    if (wave) wave.hidden = !on;
  }
}

/* ------------------------------------------------------ modo de gravacao */

/**
 * Coreografia com tempos fixos, para a gravação sair numa tomada só.
 *
 * Acertar isso ao vivo exigiria disparar três atalhos, passar o mouse na hora
 * certa, aproximar o cursor do bicho e ainda provocar um alerta — são muitas
 * tomadas. Aqui é determinístico e repetível.
 *
 * O cursor também é sintético: no vídeo ninguém vê o mouse de quem grava,
 * então sem isso o olhar do bicho ficaria parado e a parte mais viva do app
 * não apareceria.
 */
// Folga para o gravador começar antes da coreografia. Sem isso, o tempo de
// boot entra na conta e a gravação pega o reel já no meio.
const REEL_LEAD_IN = 7;

const REEL = [
  { at: 0.0, state: 'expanded' },
  { at: 2.6, state: 'detail' },
  { at: 5.4, state: 'bar' },
  { at: 7.2, state: 'pill' },
  { at: 8.4, alert: { level: 'warning', title: 'Queimando rápido', detail: '1,9%/min · acaba em ~24min', value: 78, shake: true } },
  { at: 11.0, state: 'detail' },
  { at: 14.2, state: 'hidden' },
];

/**
 * Trajetória do cursor, em fração da janela.
 *
 * Precisa ser coreografada, não um arco qualquer: o bicho foge de cursor a
 * menos de 96px, e na primeira tentativa o arco passava perto dele o tempo
 * todo — ele ficava escondido e sumia do vídeo inteiro.
 *
 * Aqui ele passa longe até os 9s, se aproxima UMA vez para o bicho fugir, e
 * se afasta para ele voltar a espiar. Vira uma cena em vez de um acidente.
 */
const REEL_PATH = [
  { at: 0.0, x: 0.2, y: 0.75 },
  { at: 3.0, x: 0.34, y: 0.55 },
  { at: 6.0, x: 0.22, y: 0.8 },
  { at: 9.0, x: 0.5, y: 0.68 },
  { at: 10.6, x: 0.88, y: 0.1 }, // chega perto: o bicho se recolhe
  { at: 12.2, x: 0.35, y: 0.85 }, // se afasta: ele volta a espiar
  { at: 15.0, x: 0.25, y: 0.75 },
];

let reelActive = false;
let reelStartedAt = 0;

/**
 * @param backdrop desenha um fundo opaco no lugar da transparência.
 *
 * Desligado por padrão: com a janela transparente, a gravação mostra o papel
 * de parede e o app aparece no contexto real, que é o que se quer num vídeo
 * de demonstração. Ligue quando não quiser expor o que estiver na tela —
 * a gravação captura tudo que estiver atrás da ilha.
 */
function startReel(backdrop) {
  if (backdrop) document.body.classList.add('is-reel');
  reelActive = true;
  reelStartedAt = performance.now() + REEL_LEAD_IN * 1000;

  for (const step of REEL) {
    setTimeout(
      () => {
        currentAlert = null;
        clearTimeout(alertTimer);
        if (step.alert) fireAlert(step.alert, 2400);
        else setBase(step.state);
      },
      (REEL_LEAD_IN + step.at) * 1000,
    );
  }
}

function reelPointer(now) {
  const t = (now - reelStartedAt) / 1000;
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (t <= REEL_PATH[0].at) return { x: REEL_PATH[0].x * w, y: REEL_PATH[0].y * h };

  for (let i = 1; i < REEL_PATH.length; i++) {
    const a = REEL_PATH[i - 1];
    const b = REEL_PATH[i];
    if (t > b.at) continue;
    // Suavização em cosseno: cursor humano não muda de direção em bico.
    const k = (1 - Math.cos((Math.PI * (t - a.at)) / (b.at - a.at))) / 2;
    return { x: (a.x + (b.x - a.x) * k) * w, y: (a.y + (b.y - a.y) * k) * h };
  }

  const last = REEL_PATH[REEL_PATH.length - 1];
  return { x: last.x * w, y: last.y * h };
}

/* -------------------------------------------------- medicao de suavidade */

/**
 * Contador de frames. Ligado com --fps.
 *
 * A media nao serve pra nada aqui: 59 fps de media com um frame de 90ms no meio
 * do morph e exatamente a travada que o olho pega. O que importa e a cauda --
 * p95, pior frame e quantos passaram de 20ms (uma perda de quadro a 60Hz).
 */
const fps = { on: false, deltas: [], since: 0, morphs: 0 };

function reportFps(now) {
  if (!fps.on || now - fps.since < 2000) return;
  const d = [...fps.deltas].sort((a, b) => a - b);
  if (!d.length) return;
  const p = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
  const dropped = d.filter((v) => v > 20).length;
  console.log(
    `[fps] ${(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1)}fps med · ` +
      `mediana ${p(0.5).toFixed(1)}ms · p95 ${p(0.95).toFixed(1)}ms · pior ${d[d.length - 1].toFixed(1)}ms · ` +
      `${dropped}/${d.length} frames >20ms · ${fps.morphs} morphs`,
  );
  fps.deltas = [];
  fps.since = now;
  fps.morphs = 0;
}

/* ------------------------------------------------------------ loop de RAF */

/** Todas as molas assentadas: nada mais tem energia pra gastar. */
function atRest() {
  return (
    geo.w.settled &&
    geo.h.settled &&
    geo.r.settled &&
    geo.y.settled &&
    geo.o.settled &&
    geo.glow.settled &&
    geo.level.settled &&
    bubble.x.settled &&
    bubble.y.settled &&
    bubble.s.settled &&
    bubble.o.settled
  );
}

let lastTime = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  const raw = now - lastTime;
  lastTime = now;
  if (fps.on) {
    fps.deltas.push(raw);
    reportFps(now);
  }

  // Escondida e tudo parado: nao ha o que desenhar. Sem esta saida o loop
  // reescreveria as CSS vars e recalcularia estilo 240x por segundo o dia
  // inteiro, pra mover nada. Qualquer comando desassenta uma mola e o proximo
  // frame ja volta a trabalhar.
  //
  // O bicho tem voto: com "espiar sozinho" ligado ele continua vivo mesmo com
  // a ilha escondida, e ai o loop precisa seguir rodando.
  if (ready && !reelActive && effective === 'hidden' && !activity.active && atRest() && critter.resting) {
    requestAnimationFrame(frame);
    return;
  }

  const w = geo.w.step(dt);
  const h = geo.h.step(dt);
  const r = geo.r.step(dt);
  const y = geo.y.step(dt);
  const o = geo.o.step(dt);
  const glow = geo.glow.step(dt);
  const level = geo.level.step(dt);
  const shakeX = shake.step(dt);

  const root = document.documentElement.style;
  root.setProperty('--w', `${w.toFixed(2)}px`);
  root.setProperty('--h', `${h.toFixed(2)}px`);
  root.setProperty('--r', `${Math.min(r, h / 2).toFixed(2)}px`);
  root.setProperty('--y', `${y.toFixed(2)}px`);
  root.setProperty('--x', `${shakeX.toFixed(2)}px`);
  root.setProperty('--o', o.toFixed(3));
  root.setProperty('--glow', glow.toFixed(3));
  // O brilho e um elemento fixo de 400x140 esticado por scale (ver style.css).
  root.setProperty('--glow-sx', (w / 400).toFixed(4));
  root.setProperty('--glow-sy', (h / 140).toFixed(4));

  // Cor so segue o nivel quando nao ha alerta pintando a ilha.
  if (!currentAlert) root.setProperty('--tone', toneFor(level));

  root.setProperty('--bubble-x', `${bubble.x.step(dt).toFixed(2)}px`);
  root.setProperty('--bubble-y', `${bubble.y.step(dt).toFixed(2)}px`);
  root.setProperty('--bubble-s', bubble.s.step(dt).toFixed(3));
  el.bubble.style.opacity = bubble.o.step(dt).toFixed(3);

  stepWave(now / 1000);
  updateHover(w, h, y);

  // O bicho fica encostado na borda direita da ilha, entao a ancora do olhar
  // anda junto com a largura -- inclusive durante o morph.
  // O bicho fica ao lado da borda direita da ilha, entao a ancora do olhar
  // anda junto com a largura -- inclusive durante o morph. Ele mesmo cuida do
  // proprio Y, que depende de quanto esta espiando.
  critter.setMood(moodNow());
  critter.step(dt, reelActive ? reelPointer(now) : pointer, window.innerWidth / 2 + shakeX + w / 2 + CRITTER_OFFSET_X);

  requestAnimationFrame(frame);
}

/** O humor do bicho e um canal de informacao, nao enfeite. */
function moodNow() {
  const used = snapshot?.ok ? snapshot.fiveHour?.used ?? 0 : 0;
  if (currentAlert?.level === 'critical' || used >= 85) return 'alarmed';
  if (activity.active) return 'keen';
  if (Date.now() - lastActiveAt > 60_000) return 'sleepy';
  return 'normal';
}

/* ---------------------------------------------------------------- hover */

let pointer = { x: -9999, y: -9999 };

// Duas fontes para a mesma coisa. O mousemove chega mesmo com click-through
// ligado (o main usa forward: true) e responde na hora, mas so vale dentro da
// janela. O rastreio global cobre o resto da tela, a 30Hz -- a mola do olhar
// suaviza a diferenca de cadencia.
window.addEventListener('mousemove', (event) => {
  pointer = { x: event.clientX, y: event.clientY };
});

window.island.onPointer((position) => {
  pointer = position;
});

function updateHover(w, h, y) {
  // Durante a gravação quem manda é a coreografia. Se o mouse real estiver
  // parado sobre a ilha, o hover travaria tudo em "detail".
  if (reelActive) return;
  if (effective === 'hidden' && !hovering) {
    if (interactive) {
      interactive = false;
      window.island.setInteractive(false);
    }
    return;
  }

  const pad = hovering ? HOVER_LEAVE_PAD : HOVER_ENTER_PAD;
  const cx = window.innerWidth / 2;
  const inside =
    pointer.x >= cx - w / 2 - pad &&
    pointer.x <= cx + w / 2 + pad &&
    pointer.y >= y - pad &&
    pointer.y <= y + h + pad;

  if (inside !== hovering) {
    hovering = inside;
    $('#content').classList.toggle('is-hovering', inside);
    if (inside) clearTimeout(alertTimer);
    applyState(resolve());
    if (!inside && currentAlert) {
      // Terminou de ler o alerta: recolhe logo em seguida.
      clearTimeout(alertTimer);
      alertTimer = setTimeout(() => {
        currentAlert = null;
        if (!pinned) setBase(idleState());
      }, 900);
    }
  }

  const shouldInteract = inside;
  if (shouldInteract !== interactive) {
    interactive = shouldInteract;
    window.island.setInteractive(shouldInteract);
  }
}

/** Só o visual do botão — usado quando quem muda `pinned` já vai reaplicar. */
function syncPin() {
  const button = $('#pin');
  button.setAttribute('aria-pressed', String(pinned));
  button.title = pinned ? 'Desafixar' : 'Fixar na tela';
}

/** Fixado = o painel fica aberto até você desafixar, mesmo sem o mouse. */
function setPinned(value) {
  pinned = value;
  syncPin();
  clearTimeout(alertTimer);
  applyState(resolve());
}

window.addEventListener('click', (event) => {
  // Os botões do canto têm dono próprio: clicar neles não pode cair no
  // comportamento genérico de clique na ilha.
  if (event.target.closest('#gear')) {
    event.stopPropagation();
    window.island.openPanel('settings');
    return;
  }
  if (event.target.closest('#pin')) {
    event.stopPropagation();
    setPinned(!pinned);
    return;
  }
  if (!hovering) return;
  setPinned(!pinned);
});

/* ------------------------------------------------------------- formatacao */

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}

/**
 * "renova em 2h14", mas "renova agora" quando falta menos de um minuto.
 * Concatenar cegamente produzia "renova em agora".
 */
function fmtReset(ms) {
  const d = fmtDuration(ms);
  if (d === null) return 'sem previsão de reset';
  return d === 'agora' ? 'renova agora' : `renova em ${d}`;
}

function fmtClock(date) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function sparkPaths(values, width = 120, height = 34) {
  if (!values || values.length < 2) return { line: '', fill: '' };
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Piso na amplitude: senao uma variacao de 0,3% vira uma montanha.
  const span = Math.max(max - min, 6);
  const lo = min - (span - (max - min)) / 2;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const norm = (v - lo) / span;
    const yy = height - 3 - Math.max(0, Math.min(1, norm)) * (height - 6);
    return [x, yy];
  });

  const line = points.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`).join(' ');
  const fill = `${line} L${width} ${height} L0 ${height} Z`;
  return { line, fill };
}

/* ---------------------------------------------------------------- render */

let ringCircumference = 0;
function setRing(node, pct) {
  if (!node) return;
  if (!ringCircumference) ringCircumference = 2 * Math.PI * 23;
  const clamped = Math.max(0, Math.min(100, pct || 0));
  node.style.strokeDasharray = String(ringCircumference);
  node.style.strokeDashoffset = String(ringCircumference * (1 - clamped / 100));
  node.style.transition = 'stroke-dashoffset .6s cubic-bezier(.32,.72,0,1)';
}

function render() {
  if (!snapshot) return;

  if (!snapshot.ok || !snapshot.fiveHour) {
    role('pill-pct').textContent = '--';
    role('reset').textContent = snapshot.bridge?.installed
      ? 'aguardando a primeira resposta'
      : 'bridge não instalado';
    role('burn').textContent = snapshot.bridge?.installed ? 'o Claude Code precisa estar aberto' : '';
    geo.level.to(0, PRESETS.smooth);
    geo.glow.to(0, PRESETS.smooth);
    return;
  }

  const five = snapshot.fiveHour;
  const week = snapshot.sevenDay;
  const used = five.used;

  geo.level.to(used, PRESETS.smooth);
  if (!currentAlert) {
    geo.glow.to(used < 60 ? 0 : Math.min(1, (used - 60) / 35), PRESETS.smooth);
  }

  // --- pilula
  role('pill-pct').textContent = `${Math.round(used)}%`;

  // --- barra
  const filled = Math.max(0, Math.min(100, used));
  role('bar-fill').style.width = `${filled}%`;
  role('bar-head').style.left = `${filled}%`;
  role('bar-pct').textContent = `${Math.round(used)}%`;

  // --- expandido
  setRing(role('ring'), used);
  setRing(role('ring-2'), used);
  role('ring-pct').textContent = Math.round(used);
  role('ring-pct-2').textContent = Math.round(used);

  const resetIn = five.resetsAt ? five.resetsAt * 1000 - Date.now() : null;
  const resetText = fmtReset(resetIn);
  role('reset').textContent = resetText;
  role('reset-2').textContent = resetText;
  role('bar-reset').textContent = resetIn != null ? `↻ ${fmtDuration(resetIn)}` : '—';

  const burn = snapshot.burnPerMin;
  const burnText = burn > 0.005 ? `${burn.toFixed(2)}%/min` : 'parado';
  role('burn').textContent =
    snapshot.minutesToLimit != null
      ? `${burnText} · acaba ~${fmtClock(new Date(Date.now() + snapshot.minutesToLimit * 60000))}`
      : burnText;
  role('burn-2').textContent = burnText;

  role('projection').textContent =
    snapshot.minutesToLimit != null
      ? fmtClock(new Date(Date.now() + snapshot.minutesToLimit * 60000))
      : '—';

  // O veredito tem cor propria, independente do nivel: "acaba antes do reset"
  // pintado de verde porque voce esta em 54% comunica o contrario do que e.
  const verdict = role('verdict');
  verdict.classList.remove('verdict--ok', 'verdict--warn', 'verdict--idle');
  if (burn <= 0.005) {
    verdict.textContent = 'parado';
    verdict.classList.add('verdict--idle');
  } else if (snapshot.willExhaust) {
    verdict.textContent = 'acaba antes do reset';
    verdict.classList.add('verdict--warn');
  } else {
    verdict.textContent = 'dá até o reset';
    verdict.classList.add('verdict--ok');
  }

  // --- semanal
  if (week) {
    role('week-bar').style.width = `${Math.min(100, week.used)}%`;
    role('week-pct').textContent = `${Math.round(week.used)}%`;
    role('week-2').textContent = `${Math.round(week.used)}%`;
  } else {
    role('week-pct').textContent = '—';
    role('week-2').textContent = '—';
  }

  // --- sparkline
  const { line, fill } = sparkPaths(snapshot.spark);
  role('spark-line').setAttribute('d', line);
  role('spark-fill').setAttribute('d', fill);

  // --- sessao ativa
  const session = snapshot.sessions?.[0];
  if (session) {
    const bits = [session.project || (session.cwd ? session.cwd.split(/[\\/]/).pop() : null), session.model].filter(Boolean);
    role('session-label').textContent = bits.join(' · ') || 'sessão ativa';
    const ctx = session.context?.usedPct;
    role('ctx-bar').style.width = `${Math.min(100, ctx || 0)}%`;
    role('ctx-pct').textContent = ctx != null ? `ctx ${Math.round(ctx)}%` : '—';
  } else {
    role('session-label').textContent = 'nenhuma sessão ativa';
    role('ctx-bar').style.width = '0%';
    role('ctx-pct').textContent = '—';
  }

  // --- historico de 7 dias
  const bars = role('bars');
  const rows = (snapshot.history || []).slice(-7);
  if (rows.length && bars.childElementCount !== rows.length) {
    bars.replaceChildren(...rows.map(() => document.createElement('div')));
  }
  if (rows.length) {
    const peak = Math.max(...rows.map((r) => r.weighted), 1);
    [...bars.children].forEach((bar, i) => {
      const row = rows[i];
      bar.style.height = `${Math.max(4, (row.weighted / peak) * 100)}%`;
      bar.title = `${row.date} · ${row.messages} mensagens`;
    });
  }

  // --- rodape: honestidade sobre a idade do dado
  const stale = snapshot.staleMs;
  const parts = [];
  if (five.resetsAt) parts.push(`reset às ${fmtClock(new Date(five.resetsAt * 1000))}`);
  const count = snapshot.sessions?.length || 0;
  if (count) parts.push(count === 1 ? '1 sessão ativa' : `${count} sessões ativas`);
  if (stale != null) {
    parts.push(stale > 180000 ? `dado de ${fmtDuration(stale)} atrás` : 'ao vivo');
  }
  role('foot').textContent = parts.join(' · ');
}

/* -------------------------------------------------------------------- IPC */

window.island.onState((payload) => {
  snapshot = payload;
  config = payload.config || config;

  document.documentElement.dataset.theme = config.theme === 'light' ? 'light' : 'dark';
  critter.setEnabled(config.critter !== false);
  critter.setShy(config.critterShy !== false);
  critter.setPeeking(effective !== 'hidden' || (config.critter !== false && config.critterAuto));
  syncTracking();

  // Sem bridge, a ilha assume o papel de instalador em vez de mentir numeros.
  if (!payload.bridge?.installed && baseState === 'hidden') {
    setBase('setup');
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => setBase('hidden'), 9000);
  }

  render();
});

window.island.onActivity((payload) => {
  activity = payload;
  if (payload.active) lastActiveAt = Date.now();
});

window.island.onCommand((payload) => {
  if (payload.type === 'boot') {
    applyState('hidden');
    if (payload.fps) {
      fps.on = true;
      fps.since = performance.now();
    }
    if (payload.reel) startReel(payload.backdrop);

    // --stress fica trocando de estado pra medicao cair em cima dos morphs,
    // que e onde a travada aparece. Ilha parada rodando a 60fps nao prova nada.
    if (payload.stress) {
      const cycle = ['pill', 'bar', 'expanded', 'detail', 'alert', 'bar', 'hidden'];
      let i = 0;
      setInterval(() => {
        const next = cycle[i++ % cycle.length];
        fps.morphs += 1;
        if (next === 'alert') {
          fireAlert({ level: 'warning', title: 'Teste de morph', detail: 'medindo frames', value: 78, shake: true }, 99999);
        } else {
          currentAlert = null;
          setBase(next);
        }
      }, 700);
    }
    return;
  }

  if (payload.type === 'alert') {
    fireAlert(payload.alert, payload.peekMs);
    return;
  }

  if (payload.type === 'toggle') {
    clearTimeout(alertTimer);
    currentAlert = null;

    if (payload.force) {
      // 'open' respeita o formato configurado; 'detail' sempre abre o painel,
      // e por isso já vem fixado — senão sumiria assim que o mouse saísse.
      pinned = payload.force === 'detail';
      syncPin();
      setBase(payload.force === 'detail' ? openState() : payload.force === 'open' ? openState() : payload.force);
      if (payload.force === 'detail') applyState('detail');
      return;
    }

    pinned = false;
    syncPin();
    setBase(baseState === 'hidden' ? openState() : 'hidden');
  }
});

/* Countdown local: o `renova em` precisa andar mesmo sem dado novo chegando. */
setInterval(() => {
  if (snapshot?.ok && effective !== 'hidden') render();
}, 1000);

/* ------------------------------------------------------------ preaquecimento */

/**
 * O primeiro morph custava 83ms -- o Chromium rasterizando pela primeira vez o
 * blur do brilho, o filtro goo, a sombra no tamanho grande e as fontes de cada
 * camada. Regime permanente e limpo, mas o engasgo caia justamente na primeira
 * vez que voce abre a ilha.
 *
 * Aqui esse custo e pago na inicializacao, com a ilha em opacidade 0.01: baixo
 * demais pra enxergar, alto o bastante pro compositor nao pular a rasterizacao
 * (com opacity:0 ele descarta a camada e o preaquecimento nao acontece).
 */
function prewarm() {
  const style = document.documentElement.style;
  const big = GEOM.detail;

  style.setProperty('--o', '0.01');
  style.setProperty('--glow', '1');
  el.goo.classList.add('is-gooing');
  geo.w.jump(big.w);
  geo.h.jump(big.h);
  geo.r.jump(big.r);
  geo.y.jump(big.y);
  bubble.o.jump(1);

  // Uma camada por frame: forca layout e rasterizacao de fonte de todas elas.
  const order = el.layers.map((l) => l.dataset.layer);
  let i = 0;

  (function tick() {
    if (i < order.length) {
      for (const layer of el.layers) {
        layer.classList.toggle('is-active', layer.dataset.layer === order[i]);
      }
      i += 1;
      requestAnimationFrame(tick);
      return;
    }

    // Desfaz tudo e comeca de verdade, escondida.
    el.goo.classList.remove('is-gooing');
    for (const layer of el.layers) layer.classList.remove('is-active');
    bubble.o.jump(0);
    style.setProperty('--glow', '0');
    geo.glow.jump(0);
    geo.w.jump(GEOM.hidden.w);
    geo.h.jump(GEOM.hidden.h);
    geo.r.jump(GEOM.hidden.r);
    geo.y.jump(GEOM.hidden.y);
    geo.o.jump(0);
    effective = 'hidden';
    ready = true;

    // So agora o handshake: "pronto" tem que significar rasterizado, nao
    // apenas carregado. Se o main mandar o boot no meio do aquecimento, o
    // primeiro morph de verdade ainda pega o custo que estamos pagando aqui.
    window.island.ready();

    // Se algum comando chegou mesmo assim, atende agora -- animado, porque a
    // essa altura tudo ja esta rasterizado.
    if (pendingState && pendingState !== 'hidden') {
      const wanted = pendingState;
      pendingState = null;
      applyState(wanted);
    }
  })();
}

prewarm();
requestAnimationFrame(frame);
