'use strict';

/**
 * Instalacao e manutencao do bridge, feitas de dentro do app.
 *
 * Empacotado nao existe `npm run`, entao tudo o que os scripts faziam mora
 * aqui: gerar o atalho de invocacao, registrar no settings.json do Claude Code,
 * fazer backup e desfazer.
 *
 * O problema central: o Claude Code precisa EXECUTAR o bridge, e um app
 * empacotado nao pode exigir Node instalado na maquina. A saida e o proprio
 * executavel do app rodando em modo Node (ELECTRON_RUN_AS_NODE) -- o Electron
 * ja embute o Node.
 *
 * Mas ha um detalhe medido na marra: nesse modo o processo e de subsistema
 * GUI, e escrever no stdout quando ele e um PIPE estoura EPIPE. Redirecionar
 * pra ARQUIVO funciona. Dai o shim .cmd: ele redireciona pra um temporario e
 * devolve o conteudo com `type`. O `chcp 65001` preserva os acentos e o simbolo
 * de reset da statusline.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { SETTINGS_FILE, STATE_DIR } = require('./paths');

const SHIM_FILE = path.join(STATE_DIR, 'statusline.cmd');
const REFRESH_SECONDS = 10;

/**
 * Como reconhecer que o statusLine gravado e nosso.
 *
 * `claude-island` era o nome antigo do app e continua na lista: sem ele, uma
 * instalacao feita antes da renomeacao seria lida como "statusLine de outra
 * pessoa" e o app se recusaria a mexer -- deixando o usuario com uma entrada
 * quebrada que so ele mesmo poderia consertar na mao.
 */
const OWN_MARKERS = ['Perch\\statusline.cmd', 'perch', 'claude-island', 'bridge/statusline.js', 'bridge\\statusline.js'];

function isOurs(command) {
  const lower = String(command).toLowerCase();
  return OWN_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * O executavel esta rodando de um diretorio temporario?
 *
 * A versao PORTATIL se extrai num diretorio aleatorio dentro do %TEMP% a cada
 * execucao, e o apaga ao fechar. Um shim apontando pra la funciona enquanto o
 * app esta aberto e morre depois -- sem erro, sem aviso, e o autoconserto nao
 * salva porque ele so roda com o app aberto.
 *
 * Pior: abrir o portatil uma unica vez CORROMPE uma instalacao que estava boa,
 * porque `refresh()` reescreve o shim apontando pro temporario.
 *
 * Por isso o portatil nao instala nem regrava o bridge. Quem quer a conexao
 * usa o instalador, que tem caminho fixo.
 */
function isEphemeral() {
  if (!app.isPackaged) return false; // em desenvolvimento o caminho e estavel
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  return path.resolve(process.execPath).toLowerCase().startsWith(tmp);
}

/** Caminho real do script, dentro ou fora do pacote. */
function scriptPath() {
  // No pacote o bridge vai em extraResources, fora do asar -- precisa ser um
  // arquivo de verdade no disco pra poder ser executado.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bridge', 'statusline.js')
    : path.join(__dirname, '..', '..', 'bridge', 'statusline.js');
}

function shimContents() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'set ELECTRON_RUN_AS_NODE=1',
    // Dois %RANDOM% dao ~1 bilhao de combinacoes: varias sessoes do Claude
    // Code renderizam ao mesmo tempo e nao podem escrever no mesmo arquivo.
    'set "CI_OUT=%TEMP%\\perch-%RANDOM%%RANDOM%.txt"',
    `"${process.execPath}" "${scriptPath()}" > "%CI_OUT%" 2>nul`,
    'type "%CI_OUT%" 2>nul',
    'erase /q "%CI_OUT%" >nul 2>&1',
    '',
  ].join('\r\n');
}

/**
 * O que deveria estar gravado no settings.json.
 *
 * Caminho absoluto, de proposito. Ja tentamos `%LOCALAPPDATA%\...` para nao
 * gravar o nome de usuario no arquivo, e **nao funciona**: o Claude Code nao
 * executa a statusLine pelo cmd. O executor de hooks aceita bash ou
 * PowerShell, e nenhum dos dois expande `%VAR%` -- o comando falha em silencio
 * e a ilha para de receber dados sem dizer por que.
 *
 * `$LOCALAPPDATA` tambem nao serve: funcionaria no bash e falharia no
 * PowerShell, que precisa de `$env:`. Como o shell varia por usuario, nao ha
 * forma portatil. Fica o caminho absoluto, que funciona em todos.
 */
function expectedCommand() {
  return `"${SHIM_FILE}"`;
}

function readSettings() {
  const text = fs.readFileSync(SETTINGS_FILE, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Regrava o shim se o conteudo mudou (app movido, atualizado, etc). */
function writeShim() {
  // Nunca apontar pro diretorio temporario do portatil: ele some ao fechar.
  if (isEphemeral()) return false;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const wanted = shimContents();
  try {
    if (fs.readFileSync(SHIM_FILE, 'utf8') === wanted) return false;
  } catch {
    /* nao existe ainda */
  }
  fs.writeFileSync(SHIM_FILE, wanted);
  return true;
}

/**
 * Estado atual, do ponto de vista do usuario.
 *   installed  o Claude Code chama o nosso bridge?
 *   foreign    ha um statusLine, mas de outra pessoa -- nao mexemos nele
 *   stale      e o nosso, mas apontando pro lugar errado
 */
function status() {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    return { ok: false, reason: 'settings-ilegivel', detail: err.message };
  }

  const ephemeral = isEphemeral();

  const current = settings.statusLine;
  if (!current || typeof current.command !== 'string') {
    return { ok: true, installed: false, foreign: false, stale: false, ephemeral };
  }

  if (!isOurs(current.command)) {
    return { ok: true, installed: false, foreign: true, ephemeral, command: current.command };
  }

  return {
    ok: true,
    installed: true,
    foreign: false,
    ephemeral,
    // Rodando do temporário, o shim não é reescrito — então não faz sentido
    // marcar como desatualizado algo que não vamos consertar.
    stale: !ephemeral && current.command !== expectedCommand(),
    command: current.command,
  };
}

function install({ force = false } = {}) {
  const state = status();
  if (!state.ok) return state;
  // Instalar daqui gravaria um caminho que some quando o app fechar.
  if (state.ephemeral) return { ok: false, reason: 'executavel-temporario' };
  if (state.foreign && !force) return { ok: false, reason: 'statusline-de-terceiro', command: state.command };

  const settings = readSettings();

  // Backup com timestamp -- nunca sobrescreve um backup anterior.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${SETTINGS_FILE}.perch-backup-${stamp}`;
  fs.copyFileSync(SETTINGS_FILE, backup);

  writeShim();
  settings.statusLine = {
    type: 'command',
    command: expectedCommand(),
    padding: 0,
    refreshInterval: REFRESH_SECONDS,
  };
  writeSettings(settings);

  return { ok: true, installed: true, backup: path.basename(backup) };
}

function uninstall() {
  const state = status();
  if (!state.ok) return state;
  if (!state.installed) return { ok: true, installed: false };

  const settings = readSettings();
  delete settings.statusLine;
  writeSettings(settings);
  return { ok: true, installed: false };
}

/**
 * Mantem a instalacao de pe. Chamado na inicializacao e periodicamente.
 *
 * Cobre dois estragos diferentes:
 *
 * 1. **Caminho velho.** Atualizar ou mover o app deixaria o Claude Code
 *    chamando um caminho que nao existe mais.
 *
 * 2. **Entrada apagada.** O `settings.json` tem DOIS escritores: o Claude Code
 *    tambem regrava o arquivo inteiro quando algo muda na config dele. Uma
 *    sessao que carregou o arquivo antes da nossa instalacao apaga a nossa
 *    chave ao regravar. Ver issue #3.
 *
 * O segundo caso e traicoeiro porque nao da erro: sessoes antigas continuam
 * chamando o bridge de memoria, entao os dados so somem quando a ultima delas
 * fecha -- horas depois, sem nada apontando pra causa.
 *
 * @param wanted o usuario pediu a conexao? Vem de `config.bridgeWanted`.
 *               Sem isso nao daria pra distinguir "apagaram" de "o usuario
 *               desconectou de proposito", e o app ficaria reinstalando por
 *               cima da decisao dele.
 */
function refresh(wanted = false) {
  const state = status();
  if (!state.ok) return state;

  // Rodando do temporario (portatil): nao mexe em nada. Reinstalar ou regravar
  // o shim daqui apontaria pra um caminho que morre ao fechar o app -- e
  // estragaria uma instalacao que estava funcionando.
  if (state.ephemeral) return state;

  // Sumiu, mas o usuario queria conectado: reinstala.
  // Nunca por cima de um statusLine de terceiro -- isso continua sendo dele.
  if (wanted && !state.installed && !state.foreign) {
    const result = install();
    return result.ok ? { ...status(), reconnected: true } : { ...state, error: result.reason };
  }

  if (!state.installed) return state;

  writeShim();
  if (state.stale) {
    const settings = readSettings();
    settings.statusLine = {
      ...settings.statusLine,
      command: expectedCommand(),
      refreshInterval: settings.statusLine.refreshInterval || REFRESH_SECONDS,
    };
    writeSettings(settings);
    return { ...state, stale: false, repaired: true };
  }
  return state;
}

module.exports = { status, install, uninstall, refresh, scriptPath, SHIM_FILE };
