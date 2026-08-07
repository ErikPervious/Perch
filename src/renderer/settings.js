'use strict';

/* =========================================================================
   Lógica do painel de configuração.

   Tudo salva na hora -- não há botão "aplicar". Cada controle é ligado pelo
   atributo `data-*` que aponta para a chave da config, então adicionar uma
   opção nova é uma linha de HTML.
   ========================================================================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let config = null;
let shortcuts = { toggle: null, detail: null, format: null };
let bridge = null;

/* ------------------------------------------------------------- utilidades */

/** Lê `schedule.enabled` a partir da string do data-attribute. */
function read(path) {
  return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), config);
}

/** Monta o patch aninhado que o main espera: "schedule.from" -> {schedule:{from}}. */
function patchFor(path, value) {
  const keys = path.split('.');
  if (keys.length === 1) return { [keys[0]]: value };
  return { [keys[0]]: { ...config[keys[0]], [keys[1]]: value } };
}

let flashTimer = null;
function flashSaved(text = 'salvo') {
  const node = $('[data-role="saved"]');
  node.textContent = text;
  node.classList.add('is-flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    node.textContent = 'salva automaticamente';
    node.classList.remove('is-flash');
  }, 1400);
}

function save(patch, note) {
  config = { ...config, ...patch };
  if (patch.schedule) config.schedule = { ...config.schedule, ...patch.schedule };
  window.settings.set(patch);
  flashSaved(note);
  paint();
}

/* -------------------------------------------------------------- atalhos */

/** Nome do acelerador no formato que o Electron entende. */
function acceleratorFrom(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  if (!parts.length) return null; // tecla solta viraria atalho global do inferno

  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null; // só modificadores

  let name;
  if (key === ' ') name = 'Space';
  else if (key === 'Escape') name = 'Escape';
  else if (key === 'Enter') name = 'Return';
  else if (key === 'Tab') name = 'Tab';
  else if (key === 'Backspace') name = 'Backspace';
  else if (/^F\d{1,2}$/.test(key)) name = key;
  else if (key.length === 1) name = key.toUpperCase();
  else name = key;

  parts.push(name);
  return parts.join('+');
}

/** Rótulo legível: Control -> Ctrl. */
function prettyAccelerator(accelerator) {
  if (!accelerator) return 'nenhum';
  return accelerator.replace('Control', 'Ctrl').split('+').join(' + ');
}

/**
 * Alerta sobre AltGr no ABNT2. Ctrl+Alt é literalmente o AltGr, então estas
 * letras deixariam de digitar seus caracteres.
 */
const ALTGR_KEYS = new Set(['Q', 'W', 'E', 'C', '1', '2', '3']);
function altGrWarning(accelerator) {
  if (!accelerator || !accelerator.startsWith('Control+Alt+')) return null;
  const key = accelerator.split('+').pop();
  if (!ALTGR_KEYS.has(key)) return null;
  return `no ABNT2 isto rouba o AltGr+${key}`;
}

let recording = null;

function startRecording(button) {
  if (recording) stopRecording();
  recording = { button, path: button.dataset.shortcut, previous: button.textContent };
  button.classList.add('is-recording');
  button.classList.remove('is-bad');
  button.textContent = 'pressione…';
}

function stopRecording() {
  if (!recording) return;
  recording.button.classList.remove('is-recording');
  recording = null;
  paint();
}

window.addEventListener('keydown', async (event) => {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    stopRecording();
    return;
  }

  const accelerator = acceleratorFrom(event);
  if (!accelerator) return; // ainda segurando só os modificadores

  const { button, path } = recording;
  button.textContent = prettyAccelerator(accelerator);

  const result = await window.settings.testShortcut(accelerator);
  if (!result.ok) {
    button.classList.remove('is-recording');
    button.classList.add('is-bad');
    button.textContent = result.reason === 'ocupado' ? 'já em uso' : 'inválido';
    setTimeout(() => {
      button.classList.remove('is-bad');
      recording = null;
      paint();
    }, 1400);
    return;
  }

  recording = null;
  button.classList.remove('is-recording');
  save({ [path]: accelerator }, 'atalho salvo');
});

/* ----------------------------------------------------------- desenhar UI */

/** Estado do bridge em uma frase e um botão. */
function paintBridge() {
  const button = $('[data-action="bridge-toggle"]');
  const hint = $('[data-role="bridge-hint"]');
  button.classList.remove('is-on', 'is-warn');
  button.disabled = false;

  if (!bridge) {
    hint.textContent = 'verificando…';
    button.textContent = '—';
    button.disabled = true;
    return;
  }

  if (!bridge.ok) {
    hint.textContent = `não consegui ler o settings.json — ${bridge.detail || bridge.reason}`;
    button.textContent = 'indisponível';
    button.disabled = true;
    button.classList.add('is-warn');
    return;
  }

  if (bridge.foreign) {
    // Não sobrescrevemos configuração de terceiro sem o usuário mandar.
    hint.textContent = 'você já tem outro statusLine configurado';
    button.textContent = 'substituir';
    button.classList.add('is-warn');
    return;
  }

  if (bridge.installed) {
    // Reconexão automática precisa aparecer. Se a entrada some e volta sem
    // dizer nada, o usuário não tem como saber que houve um buraco nos dados.
    const reconnected = bridge.lastReconnectAt && Date.now() - bridge.lastReconnectAt < 6 * 60 * 60 * 1000;
    if (bridge.stale) hint.textContent = 'instalado, mas apontando pro lugar errado';
    else if (reconnected) {
      const min = Math.round((Date.now() - bridge.lastReconnectAt) / 60000);
      hint.textContent = `conectado — a entrada tinha sumido e foi reposta há ${min < 1 ? 'instantes' : `${min} min`}`;
    } else hint.textContent = 'conectado — os números chegam por aqui';
    button.textContent = 'desconectar';
    button.classList.add('is-on');
    return;
  }

  hint.textContent = 'desconectado — a ilha fica sem números';
  button.textContent = 'conectar';
}

function paint() {
  if (!config) return;

  document.documentElement.dataset.theme = config.theme === 'light' ? 'light' : 'dark';
  paintBridge();

  for (const group of $$('[data-segment]')) {
    const current = read(group.dataset.segment);
    for (const button of group.children) {
      button.classList.toggle('is-on', button.dataset.value === current);
    }
  }

  for (const button of $$('[data-switch]')) {
    button.setAttribute('aria-checked', String(!!read(button.dataset.switch)));
  }

  for (const input of $$('[data-range]')) {
    input.value = read(input.dataset.range);
  }
  $('[data-role="peekMs-value"]').textContent = `${(config.peekMs / 1000).toFixed(1)}s`;

  for (const input of $$('[data-time]')) {
    input.value = read(input.dataset.time) || '';
  }

  const days = config.schedule?.days || [];
  for (const chip of $$('[data-days] button')) {
    chip.classList.toggle('is-on', days.includes(Number(chip.dataset.day)));
  }

  // Atalhos: mostra o configurado e avisa quando o que vale é outro.
  for (const button of $$('[data-shortcut]')) {
    if (recording && recording.button === button) continue;
    const path = button.dataset.shortcut;
    button.textContent = prettyAccelerator(read(path));

    const active = { shortcut: shortcuts.toggle, detailShortcut: shortcuts.detail, formatShortcut: shortcuts.format }[path];
    const hint = $(`[data-role="hint-${path}"]`);
    const warning = altGrWarning(read(path));

    if (!active) hint.textContent = 'nenhum atalho livre — use a bandeja';
    else if (active !== read(path)) hint.textContent = `ocupado; valendo ${prettyAccelerator(active)}`;
    else if (warning) hint.textContent = warning;
    else hint.textContent = 'livre nesta máquina';
  }

  // O ciclo é o caminho rápido pro formato, então vale lembrar dele bem aqui,
  // e não só lá embaixo na seção de atalhos.
  $('[data-role="hint-format"]').textContent = shortcuts.format
    ? `o que o atalho abre — ${prettyAccelerator(shortcuts.format)} cicla entre os três`
    : 'o que o atalho abre; o hover sempre expande';

  // Campos de horário desligam junto com a chave.
  const on = !!config.schedule?.enabled;
  $('[data-role="schedule-fields"]').classList.toggle('is-off', !on);
  $('[data-role="schedule-days"]').classList.toggle('is-off', !on);
  $('[data-role="schedule-summary"]').textContent = on
    ? `das ${config.schedule.from} às ${config.schedule.to}`
    : 'sem restrição';
}

/* -------------------------------------------------------------- eventos */

document.addEventListener('click', (event) => {
  const target = event.target;

  const segment = target.closest('[data-segment] button');
  if (segment) {
    save(patchFor(segment.parentElement.dataset.segment, segment.dataset.value));
    return;
  }

  const toggle = target.closest('[data-switch]');
  if (toggle) {
    const path = toggle.dataset.switch;
    save(patchFor(path, !read(path)));
    return;
  }

  const chip = target.closest('[data-days] button');
  if (chip) {
    const day = Number(chip.dataset.day);
    const days = new Set(config.schedule?.days || []);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    save(patchFor('schedule.days', [...days].sort()));
    return;
  }

  const recorder = target.closest('[data-shortcut]');
  if (recorder) {
    startRecording(recorder);
    return;
  }

  const bridgeButton = target.closest('[data-action="bridge-toggle"]');
  if (bridgeButton) {
    const action = bridge?.foreign ? 'force' : bridge?.installed ? 'uninstall' : 'install';
    bridgeButton.disabled = true;
    bridgeButton.textContent = '…';
    window.settings.bridge(action).then((result) => {
      if (result && result.ok === false) {
        flashSaved(`falhou: ${result.reason}`);
      } else {
        flashSaved(action === 'uninstall' ? 'desconectado' : 'conectado');
      }
    });
    return;
  }

  if (target.closest('[data-action="close"]')) window.settings.close();
  if (target.closest('[data-action="open-data"]')) window.settings.openDataFolder();
});

// O range dispara muito: pinta na hora, grava só ao soltar.
for (const input of $$('[data-range]')) {
  input.addEventListener('input', () => {
    $('[data-role="peekMs-value"]').textContent = `${(Number(input.value) / 1000).toFixed(1)}s`;
  });
  input.addEventListener('change', () => save(patchFor(input.dataset.range, Number(input.value))));
}

for (const input of $$('[data-time]')) {
  input.addEventListener('change', () => save(patchFor(input.dataset.time, input.value)));
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !recording) window.settings.close();
});

function adopt(payload) {
  config = payload.config;
  shortcuts = payload.shortcuts || shortcuts;
  if (payload.bridge) bridge = payload.bridge;
  if (payload.version) $('[data-role="subtitle"]').textContent = `configurações · v${payload.version}`;
  paint();
}

window.settings.onChanged(adopt);
window.settings.load().then(adopt);
