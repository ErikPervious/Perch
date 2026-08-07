'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_FILE, STATE_DIR } = require('./paths');

const DEFAULTS = {
  // --- atalhos
  //
  // Ctrl+Alt+J / K sao tres teclas, estao livres globalmente e nao sao
  // atalho padrao de VS Code nem de navegador. E, no teclado ABNT2, o AltGr
  // *e* Ctrl+Alt -- entao letras que geram caractere com AltGr estao fora:
  // Q(/), W(?), E(€), C(₢) e os numeros 1, 2 e 3 (expoentes). J e K nao geram
  // nada, entao nao roubam digitacao.
  shortcut: 'Control+Alt+J',
  detailShortcut: 'Control+Alt+K',
  formatShortcut: 'Control+Alt+L', // cicla card -> barra -> pilula

  // --- aparencia
  theme: 'dark', // 'dark' | 'light'
  format: 'card', // formato que o atalho abre: 'card' | 'bar' | 'pill'
  accent: 'auto', // 'auto' segue o nivel de uso; ou um hex fixo

  // --- bridge
  //
  // Guarda a INTENCAO do usuario, nao o estado do settings.json. E o que
  // permite distinguir "apagaram nossa entrada" de "o usuario desconectou de
  // proposito" -- sem isso o app reinstalaria por cima da decisao dele.
  bridgeWanted: false,

  // --- atualizacao
  //
  // A UNICA requisicao de rede do app: um GET anonimo na API publica de
  // releases do GitHub. Nada e enviado. `updateSeen` guarda a ultima versao
  // ja anunciada, pra ilha avisar uma vez por versao em vez de a cada abertura.
  checkUpdates: true,
  updateSeen: null,

  // --- comportamento
  autoDrop: true, // descer sozinha nos gatilhos
  idleVisible: false, // manter uma pilula discreta quando ocioso
  liveActivity: true, // waveform enquanto o Claude gera
  peekMs: 4200, // quanto tempo fica na tela ao descer sozinha
  display: 'primary', // 'primary' | 'cursor'

  // --- o bicho
  critter: true,
  critterAuto: false, // espiar mesmo com a ilha escondida
  critterShy: true, // fugir quando o mouse chega perto

  // --- horarios em que a ilha pode aparecer sozinha
  schedule: {
    enabled: false,
    from: '09:00',
    to: '19:00',
    days: [1, 2, 3, 4, 5], // 0 = domingo
  },
};

/** Mescla rasa, mas com `schedule` tratado como objeto proprio. */
function merge(base, patch) {
  const out = { ...base, ...patch };
  if (patch && patch.schedule) out.schedule = { ...base.schedule, ...patch.schedule };
  return out;
}

/**
 * `JSON.parse` engasga com BOM, e no Windows quase todo editor de texto grava
 * UTF-8 com BOM -- Bloco de Notas, PowerShell `Out-File -Encoding utf8`, etc.
 * Sem esta limpeza, editar o config.json na mao zera todas as preferencias em
 * silencio, porque o catch devolve os padroes.
 */
function parseJson(text) {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function load() {
  try {
    return merge(DEFAULTS, parseJson(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return { ...DEFAULTS, schedule: { ...DEFAULTS.schedule } };
  }
}

function save(config) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch {
    /* preferencia nao e critica */
  }
  return config;
}

/**
 * A ilha esta dentro do horario permitido?
 * Faixas que atravessam a meia-noite (22:00 -> 02:00) sao suportadas.
 * Vale so para aparicoes automaticas -- o atalho sempre funciona.
 */
function withinSchedule(config, now = new Date()) {
  const s = config.schedule;
  if (!s || !s.enabled) return true;

  if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.getDay())) return false;

  const toMinutes = (text, fallback) => {
    const [h, m] = String(text || '').split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : fallback;
  };
  const from = toMinutes(s.from, 0);
  const to = toMinutes(s.to, 24 * 60 - 1);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return from <= to ? nowMin >= from && nowMin <= to : nowMin >= from || nowMin <= to;
}

module.exports = { load, save, merge, withinSchedule, DEFAULTS, CONFIG_FILE: path.normalize(CONFIG_FILE) };
