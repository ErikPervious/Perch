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
let updates = null;

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

/* ---------------------------------------------------------- atualização */

/* ------------------------------------------------ renderização de markdown

   As notas da release vêm da API do GitHub, ou seja, **da rede**. Por isso
   tudo aqui é montado com createElement e textContent: nada de innerHTML, ou
   markdown numa release vira injeção de HTML dentro do painel.

   Cobre o que notas de release realmente usam — títulos, listas, tabelas,
   negrito, código, links e parágrafos. Não é um renderizador completo de
   CommonMark, e não precisa ser: trazer uma biblioteca quebraria o "zero
   dependências" por causa de uma caixinha de texto.
*/

/** Aplica negrito, código e links dentro de uma linha, devolvendo nós. */
function inline(text, into) {
  // Uma varredura só, alternando entre os três padrões.
  const pattern = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) into.append(document.createTextNode(text.slice(last, match.index)));

    if (match[2] !== undefined) {
      // Recursivo: negrito frequentemente envolve código nas notas de release
      // (`**\`arquivo.exe\`**`). Sem descer um nível, as crases apareceriam
      // como texto dentro do negrito.
      into.append(inline(match[2], document.createElement('strong')));
    } else if (match[4] !== undefined) {
      // Dentro de código nada mais é markdown — este é o caso base.
      const code = document.createElement('code');
      code.textContent = match[4];
      into.append(code);
    } else {
      // Link: só o texto vira clicável, e só para http(s).
      const url = match[7];
      if (/^https?:\/\//i.test(url)) {
        const a = inline(match[6], document.createElement('a'));
        a.href = url;
        a.className = 'md__link';
        into.append(a);
      } else {
        into.append(document.createTextNode(match[6]));
      }
    }
    last = pattern.lastIndex;
  }

  if (last < text.length) into.append(document.createTextNode(text.slice(last)));
  return into;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** Converte markdown em um fragmento de DOM pronto para inserir. */
function renderMarkdown(markdown) {
  const lines = String(markdown || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Bloco de código cercado. Precisa vir antes de tudo: dentro dele nada
    // é markdown, e sem tratar isso as próprias cercas vazam como parágrafo.
    const fence = line.match(/^\s*```/);
    if (fence) {
      const parts = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      i += 1; // consome a cerca de fechamento
      const pre = document.createElement('pre');
      pre.className = 'md__code';
      pre.textContent = parts.join('\n').trim();
      frag.append(pre);
      continue;
    }

    // Título
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const el = document.createElement('div');
      el.className = 'md__title';
      inline(heading[2], el);
      frag.append(el);
      i += 1;
      continue;
    }

    // Tabela
    if (isTableRow(line) && isTableRow(lines[i + 1] || '') && isDivider(lines[i + 1])) {
      const table = document.createElement('table');
      table.className = 'md__table';
      const head = document.createElement('tr');
      for (const cell of cells(line)) {
        const th = document.createElement('th');
        inline(cell, th);
        head.append(th);
      }
      table.append(head);
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const tr = document.createElement('tr');
        for (const cell of cells(lines[i])) {
          const td = document.createElement('td');
          inline(cell, td);
          tr.append(td);
        }
        table.append(tr);
        i += 1;
      }
      frag.append(table);
      continue;
    }

    // Lista
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'md__list';
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s{2,}\S/.test(lines[i]) && list.lastElementChild) {
          // Continuação do item anterior, quebrado em várias linhas.
          list.lastElementChild.append(document.createTextNode(` ${lines[i].trim()}`));
        } else {
          const li = document.createElement('li');
          inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''), li);
          list.append(li);
        }
        i += 1;
      }
      frag.append(list);
      continue;
    }

    // Citação
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('div');
      quote.className = 'md__quote';
      const parts = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      inline(parts.join(' '), quote);
      frag.append(quote);
      continue;
    }

    // Parágrafo: junta linhas até a próxima em branco ou bloco novo.
    const parts = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*([-*]|\d+\.)\s|\s*>)/.test(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      parts.push(lines[i].trim());
      i += 1;
    }
    if (parts.length) {
      const p = document.createElement('p');
      p.className = 'md__p';
      inline(parts.join(' '), p);
      frag.append(p);
    }
  }

  return frag;
}

function fmtWhen(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return 'publicada hoje';
  if (days === 1) return 'publicada ontem';
  return `publicada há ${days} dias`;
}

function paintUpdates() {
  const card = $('[data-role="update-card"]');
  const status = $('[data-role="update-status"]');
  const checkRow = $('[data-role="update-check-row"]');

  checkRow.classList.toggle('is-off', config.checkUpdates === false);

  if (!updates) {
    status.textContent = 'verificando…';
    card.hidden = true;
    return;
  }

  if (config.checkUpdates === false) {
    status.textContent = `desligado · você está na ${updates.current}`;
  } else if (updates.lastError) {
    const motivo = updates.lastError === 'limite-de-consultas' ? 'limite da API atingido' : `falhou (${updates.lastError})`;
    status.textContent = `${motivo} · você está na ${updates.current}`;
  } else if (updates.available) {
    status.textContent = `${updates.latest.version} disponível · você está na ${updates.current}`;
  } else if (updates.lastCheckedAt) {
    const min = Math.round((Date.now() - updates.lastCheckedAt) / 60000);
    status.textContent = `${updates.current} é a mais recente · verificado há ${min < 1 ? 'instantes' : `${min} min`}`;
  } else {
    status.textContent = `você está na ${updates.current}`;
  }

  if (!updates.available) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  $('[data-role="update-version"]').textContent = `Perch ${updates.latest.version}`;
  $('[data-role="update-when"]').textContent = fmtWhen(updates.latest.publishedAt);

  const box = $('[data-role="update-notes"]');
  box.replaceChildren();
  const notes = (updates.latest.notes || '').trim();
  if (!notes) {
    const p = document.createElement('p');
    p.className = 'md__p';
    p.textContent = 'Esta versão foi publicada sem notas.';
    box.append(p);
    return;
  }
  box.append(renderMarkdown(notes));
}

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

  // Portátil: o executável vive num temporário que some ao fechar. Conectar
  // daqui gravaria um caminho morto, então nem oferecemos.
  if (bridge.ephemeral) {
    hint.textContent = 'a versão portátil não pode conectar — use o instalador';
    button.textContent = 'indisponível';
    button.disabled = true;
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
  paintUpdates();

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

  const check = target.closest('[data-action="check-updates"]');
  if (check) {
    check.disabled = true;
    check.textContent = '…';
    window.settings.checkUpdates().then((state) => {
      updates = state;
      check.disabled = false;
      check.textContent = 'Verificar';
      flashSaved(state.available ? `${state.latest.version} disponível` : 'já está atualizado');
      paint();
    });
    return;
  }

  if (target.closest('[data-action="open-release"]')) {
    window.settings.openRelease();
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
  if (payload.updates) updates = payload.updates;
  if (payload.version) $('[data-role="subtitle"]').textContent = `configurações · v${payload.version}`;
  paint();
}

window.settings.onChanged(adopt);
window.settings.load().then(adopt);
