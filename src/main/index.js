'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');

const { UsageStore } = require('./usage');
const { TranscriptWatcher } = require('./transcripts');
const { TriggerEngine } = require('./triggers');
const { trayIcon } = require('./icon');
const configStore = require('./config');
const bridge = require('./bridge');
const { UpdateChecker } = require('./updates');
const { STATE_FILE, STATE_DIR, migrateLegacy } = require('./paths');

// A janela e maior que a ilha de proposito: ela nunca redimensiona.
// Todo o movimento acontece num elemento HTML dentro dela -- redimensionar a
// janela do SO a cada frame e o que faz esse tipo de app parecer travado.
const WIN_WIDTH = 760;
const WIN_HEIGHT = 360;

let win = null;
let tray = null;
let config = configStore.load();

const usage = new UsageStore();
const transcripts = new TranscriptWatcher();
const triggers = new TriggerEngine();

let lastSnapshot = null;
let lastActivity = { active: false, intensity: 0 };
let history = [];

// ---------------------------------------------------------------- janela

function targetDisplay() {
  if (config.display === 'cursor') {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  return screen.getPrimaryDisplay();
}

function positionWindow() {
  if (!win) return;
  const { bounds } = targetDisplay();
  win.setBounds({
    x: Math.round(bounds.x + (bounds.width - WIN_WIDTH) / 2),
    y: bounds.y,
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // focusable:false evita roubar o foco do editor enquanto voce digita.
    // A interacao e por hover + atalho global, entao nao perdemos nada.
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // senao a animacao morre quando perde foco
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Sem janela visivel de devtools, um erro de modulo no renderer some sem
  // deixar rastro. Nos modos de teste, tudo vai pro stdout.
  if (process.argv.some((a) => ['--dev', '--demo', '--show', '--fps', '--stress'].includes(a))) {
    // stderr, nao stdout: no Windows o Electron e um app de subsistema GUI e o
    // stdout do processo principal nao chega em quem redirecionou.
    //
    // A assinatura deste evento mudou no Electron 37: antes vinham cinco
    // argumentos soltos, agora vem um objeto so. Aceitar as duas formas evita
    // que a proxima atualizacao quebre o diagnostico em silencio -- que e
    // justamente a ferramenta usada pra descobrir que algo quebrou.
    win.webContents.on('console-message', (...args) => {
      const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
      const level = details ? details.level : args[1];
      const message = details ? details.message : args[2];
      const line = details ? details.lineNumber : args[3];
      const source = details ? details.sourceId : args[4];
      process.stderr.write(`[renderer:${level}] ${message}  (${String(source).split('/').pop()}:${line})\n`);
    });
    win.webContents.on('render-process-gone', (_event, details) =>
      console.error('[renderer] morreu:', details.reason),
    );
  }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Comeca transparente ao mouse: a barra de titulo do que estiver embaixo
  // precisa continuar clicavel. O renderer liga/desliga isso no hover.
  win.setIgnoreMouseEvents(true, { forward: true });

  positionWindow();
  win.once('ready-to-show', () => win.showInactive());

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------- janela de config

let settingsWin = null;

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 600,
    height: 700,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    center: true, // centralizada na tela, como pedido
    show: false,
    // Ao contrario da ilha, esta janela precisa de foco e de teclado -- e onde
    // o atalho e gravado.
    focusable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function sendSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}

// --------------------------------------------------------- saude do bridge

let lastReconnectAt = null;

/** Reinstala o statusLine se ele sumir sem o usuario ter pedido. */
function keepBridgeAlive() {
  const state = bridge.refresh(config.bridgeWanted === true);

  if (state.reconnected) {
    lastReconnectAt = Date.now();
    console.error('[perch] statusLine tinha sumido do settings.json; reconectado');
  } else if (state.repaired) {
    console.error('[perch] statusLine apontava pro lugar errado; corrigido');
  } else {
    return;
  }

  pushState();
  sendSettings('settings:changed', { config, shortcuts: activeShortcuts, bridge: bridgeStatus() });
}

/** Status do bridge com o carimbo da última reconexão automática. */
function bridgeStatus() {
  return { ...bridge.status(), wanted: config.bridgeWanted === true, lastReconnectAt };
}

// ------------------------------------------------------------ atualizacao

const updates = new UpdateChecker(app.getVersion());

/**
 * Nova versão avisa UMA vez, e de forma discreta.
 *
 * Atualização não é urgente como cota em 90%. Se ela sequestrar a ilha do
 * mesmo jeito, desvaloriza o alerta que importa -- e vale aqui o mesmo
 * princípio do resto do app: aviso que aparece demais deixa de ser aviso.
 *
 * O canal permanente é a bandeja e o painel, que continuam lá quando você
 * voltar para a máquina. A descida da ilha é só o toque inicial, uma vez por
 * versão, e respeitando a faixa de horários configurada.
 */
function onUpdateAvailable(state) {
  if (tray) tray.setContextMenu(buildTrayMenu());
  pushState();
  sendSettings('settings:changed', { config, shortcuts: activeShortcuts, bridge: bridgeStatus(), updates: state });

  if (config.updateSeen === state.latest.version) return;
  updateConfig({ updateSeen: state.latest.version });

  if (!configStore.withinSchedule(config)) return;
  send('island:command', {
    type: 'alert',
    peekMs: Math.max(config.peekMs, 5200),
    alert: {
      kind: 'update',
      level: 'info',
      title: `Perch ${state.latest.version} disponível`,
      detail: 'detalhes nas configurações',
      value: 0,
    },
  });
}

// ---------------------------------------------------------------- estado

function pushState() {
  const snapshot = lastSnapshot || usage.snapshot;
  const status = bridgeStatus();
  send('island:state', {
    ...snapshot,
    history,
    config,
    bridge: { ...status, stateFileExists: fs.existsSync(STATE_FILE) },
  });
}

let trayTone = null;
function refreshTray() {
  if (!tray) return;
  const snapshot = lastSnapshot;
  let tone = 'idle';
  if (snapshot?.ok && snapshot.fiveHour) {
    const used = snapshot.fiveHour.used;
    tone = used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'good';
  }
  if (tone !== trayTone) {
    trayTone = tone;
    tray.setImage(nativeImage.createFromBuffer(trayIcon(tone)));
  }
  const label =
    snapshot?.ok && snapshot.fiveHour
      ? `Perch — 5h ${Math.round(snapshot.fiveHour.used)}%`
      : 'Perch — aguardando o bridge';
  tray.setToolTip(label);
}

// ---------------------------------------------------------------- bandeja

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: activeShortcuts.toggle ? `Mostrar ilha  (${activeShortcuts.toggle})` : 'Mostrar ilha  (sem atalho livre)',
      // 'open' deixa o renderer decidir entre card, barra ou pilula.
      click: () => send('island:command', { type: 'toggle', force: 'open' }),
    },
    {
      label: activeShortcuts.detail ? `Detalhes  (${activeShortcuts.detail})` : 'Detalhes',
      click: () => send('island:command', { type: 'toggle', force: 'detail' }),
    },
    {
      label: activeShortcuts.format
        ? `Trocar formato: ${config.format}  (${activeShortcuts.format})`
        : `Trocar formato: ${config.format}`,
      click: () => cycleFormat(),
    },
    { type: 'separator' },
    ...(updates.state.available
      ? [
          {
            label: `⬆  Atualizar para ${updates.state.latest.version}`,
            click: () => shell.openExternal(updates.state.latest.url),
          },
        ]
      : []),
    { label: 'Configurações…', click: () => createSettingsWindow() },
    { type: 'separator' },
    // Atalhos rapidos pro que se mexe no dia a dia. O resto mora no painel.
    {
      label: 'Descer sozinha nos alertas',
      type: 'checkbox',
      checked: config.autoDrop,
      click: (item) => updateConfig({ autoDrop: item.checked }),
    },
    {
      label: 'Mostrar o bicho',
      type: 'checkbox',
      checked: config.critter !== false,
      click: (item) => updateConfig({ critter: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Abrir com o Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: [] }),
    },
    { label: 'Sair', click: () => app.quit() },
  ]);
}

function updateConfig(patch) {
  const before = config;
  config = configStore.save(configStore.merge(config, patch));

  // Atalho mudou: registra de novo antes de reconstruir o menu, senao ele
  // mostra o acelerador antigo.
  if (
    patch.shortcut !== undefined ||
    patch.detailShortcut !== undefined ||
    patch.formatShortcut !== undefined
  ) {
    registerShortcuts();
  }
  if (patch.display !== undefined && patch.display !== before.display) positionWindow();

  if (patch.checkUpdates !== undefined && patch.checkUpdates !== before.checkUpdates) {
    if (patch.checkUpdates) updates.start();
    else updates.stop();
  }

  if (tray) tray.setContextMenu(buildTrayMenu());
  pushState();
  sendSettings('settings:changed', { config, shortcuts: activeShortcuts, bridge: bridgeStatus() });
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(trayIcon('idle')));
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => send('island:command', { type: 'toggle' }));
  refreshTray();
}

// ---------------------------------------------------------------- atalhos

// Se o atalho configurado estiver ocupado, desce a lista ate achar um livre e
// mostra qual ficou valendo no menu da bandeja, em vez de falhar em silencio.
//
// Ctrl+Shift+Space ficou de fora: o VS Code usa pra dicas de parametro, e um
// atalho global rouba do app em foco.
const FALLBACK_TOGGLE = ['Control+Alt+J', 'Control+Alt+Y', 'Control+Alt+F9', 'Alt+Shift+J'];
const FALLBACK_DETAIL = ['Control+Alt+K', 'Control+Alt+Z', 'Control+Alt+F12', 'Alt+Shift+K'];
const FALLBACK_FORMAT = ['Control+Alt+L', 'Control+Alt+H', 'Control+Alt+N', 'Control+Alt+B'];

let activeShortcuts = { toggle: null, detail: null, format: null };

// Ordem do ciclo de formatos. Do mais informativo pro mais discreto.
const FORMATS = ['card', 'bar', 'pill'];

/**
 * Troca o formato e mostra o resultado.
 *
 * O formato mora na config (o main e o dono dela), entao o ciclo acontece aqui
 * e o renderer so recebe o estado novo -- na ordem certa, porque o IPC preserva
 * a sequencia: primeiro o config novo, depois o comando de abrir.
 */
function cycleFormat() {
  const next = FORMATS[(FORMATS.indexOf(config.format) + 1) % FORMATS.length];
  updateConfig({ format: next });
  send('island:command', { type: 'toggle', force: 'open' });
}

function registerFirstAvailable(candidates, handler) {
  for (const accelerator of candidates) {
    if (!accelerator) continue;
    try {
      if (globalShortcut.register(accelerator, handler)) return accelerator;
    } catch {
      /* acelerador invalido na config do usuario */
    }
  }
  return null;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();

  const toggleList = [config.shortcut, ...FALLBACK_TOGGLE.filter((a) => a !== config.shortcut)];
  activeShortcuts.toggle = registerFirstAvailable(toggleList, () => {
    send('island:command', { type: 'toggle' });
  });

  const detailList = [config.detailShortcut, ...FALLBACK_DETAIL.filter((a) => a !== config.detailShortcut)];
  activeShortcuts.detail = registerFirstAvailable(detailList, () => {
    send('island:command', { type: 'toggle', force: 'detail' });
  });

  const formatList = [config.formatShortcut, ...FALLBACK_FORMAT.filter((a) => a !== config.formatShortcut)];
  activeShortcuts.format = registerFirstAvailable(formatList, cycleFormat);

  if (!activeShortcuts.toggle) {
    console.warn('[island] nenhum atalho disponivel — use o icone da bandeja');
  } else if (activeShortcuts.toggle !== config.shortcut) {
    console.warn(`[island] ${config.shortcut} esta ocupado, usando ${activeShortcuts.toggle}`);
  }
}

// ---------------------------------------------------------------- ciclo

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => send('island:command', { type: 'toggle' }));

  // Sem janela na barra de tarefas: isso aqui vive na bandeja.
  if (process.platform === 'win32') app.setAppUserModelId('app.perch.desktop');

  app.whenReady().then(() => {
    // Traz dados da pasta do nome antigo, se houver.
    migrateLegacy();
    keepBridgeAlive();
    // O settings.json tem dois escritores: o Claude Code regrava o arquivo
    // inteiro quando a config dele muda, e leva a nossa chave junto. Isso
    // acontece com o Perch ja rodando, entao verificar so na inicializacao nao
    // resolve. E uma leitura de arquivo pequeno por minuto. Ver issue #3.
    setInterval(keepBridgeAlive, 60_000);

    createWindow();
    // Registra antes da bandeja: o menu mostra qual atalho ficou valendo.
    registerShortcuts();
    createTray();

    usage.on('update', (snapshot) => {
      lastSnapshot = snapshot;
      pushState();
      refreshTray();

      // O gatilho e sempre avaliado (pra nao disparar retroativamente quando o
      // horario abrir), mas so vira aparicao dentro da faixa configurada.
      const alert = triggers.evaluate(snapshot);
      if (!alert || !config.autoDrop || !configStore.withinSchedule(config)) return;
      send('island:command', { type: 'alert', alert, peekMs: config.peekMs });
    });
    usage.start();

    transcripts.on('activity', (activity) => {
      // So empurra quando muda de estado ou quando esta ativo, pra nao
      // acordar o renderer a cada 1.2s a toa.
      const changed = activity.active !== lastActivity.active || activity.active;
      lastActivity = activity;
      if (changed && config.liveActivity) send('island:activity', activity);
    });
    transcripts.on('history', (rows) => {
      history = rows;
      pushState();
    });
    transcripts.start().catch((err) => console.error('[island] watcher de transcripts falhou:', err.message));

    updates.on('available', onUpdateAvailable);
    if (config.checkUpdates !== false) updates.start();

    screen.on('display-metrics-changed', positionWindow);
    screen.on('display-added', positionWindow);
    screen.on('display-removed', positionWindow);
  });

  // O renderer avisa quando seus listeners estao no ar. So entao o estado
  // inicial e o boot sao enviados -- antes disso eles se perderiam.
  ipcMain.on('island:renderer-ready', () => {
    pushState();
    send('island:command', {
      type: 'boot',
      fps: process.argv.includes('--fps'),
      stress: process.argv.includes('--stress'),
    });

    // --show / --demo abrem a ilha ja na inicializacao, sem depender do atalho
    // global. Util pra conferir o visual depois de mexer no CSS.
    const forced = process.argv.includes('--demo')
      ? 'detail'
      : process.argv.includes('--show')
        ? 'open'
        : null;
    if (forced) setTimeout(() => send('island:command', { type: 'toggle', force: forced }), 350);
    if (process.argv.includes('--settings')) setTimeout(createSettingsWindow, 500);
  });

  // Rastreio global do cursor.
  //
  // O `mousemove` do renderer so chega quando o ponteiro esta sobre a janela
  // (760x360 no topo da tela). Fora dali os olhos do bicho congelavam -- que e
  // a maior parte do tempo. `getCursorScreenPoint` ve a tela inteira.
  //
  // Ambos vem em DIP, entao a subtracao ja da coordenada relativa a janela em
  // pixels de CSS. Roda so com a ilha visivel: escondida, nao ha o que olhar.
  let pointerTimer = null;
  ipcMain.on('island:track', (_event, on) => {
    if (on && !pointerTimer) {
      pointerTimer = setInterval(() => {
        if (!win || win.isDestroyed()) return;
        const cursor = screen.getCursorScreenPoint();
        const bounds = win.getBounds();
        send('island:pointer', { x: cursor.x - bounds.x, y: cursor.y - bounds.y });
      }, 33);
    } else if (!on && pointerTimer) {
      clearInterval(pointerTimer);
      pointerTimer = null;
    }
  });

  ipcMain.on('island:interactive', (_event, interactive) => {
    if (!win || win.isDestroyed()) return;
    if (interactive) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });

  ipcMain.on('island:hide', () => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
  });

  ipcMain.on('island:open-panel', (_event, which) => {
    if (which === 'data') shell.openPath(STATE_DIR);
    else createSettingsWindow();
  });

  // ------------------------------------------------- IPC da tela de config

  ipcMain.handle('settings:get', () => ({
    config,
    shortcuts: activeShortcuts,
    defaults: configStore.DEFAULTS,
    bridge: bridgeStatus(),
    updates: updates.state,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:check-updates', async () => {
    const state = await updates.check();
    sendSettings('settings:changed', { config, shortcuts: activeShortcuts, bridge: bridgeStatus(), updates: state });
    return state;
  });

  ipcMain.on('settings:open-release', () => {
    shell.openExternal(updates.state.latest?.url || updates.state.page);
  });

  ipcMain.handle('settings:bridge', (_event, action) => {
    const result =
      action === 'install' ? bridge.install() : action === 'force' ? bridge.install({ force: true }) : bridge.uninstall();

    // Registra a intencao, nao o resultado: e ela que autoriza o autoconserto
    // quando outro processo apaga a entrada do settings.json (issue #3).
    if (result.ok) updateConfig({ bridgeWanted: action !== 'uninstall' });

    pushState();
    sendSettings('settings:changed', { config, shortcuts: activeShortcuts, bridge: bridgeStatus() });
    return result;
  });
  ipcMain.on('settings:set', (_event, patch) => updateConfig(patch || {}));
  ipcMain.on('settings:close', () => settingsWin && !settingsWin.isDestroyed() && settingsWin.close());
  ipcMain.on('settings:open-data', () => shell.openPath(STATE_DIR));

  /**
   * Testa um acelerador antes de gravar. Registrar e desregistrar na hora e a
   * unica forma confiavel de saber se outro programa ja tomou o atalho -- nao
   * ha API de consulta no Windows.
   */
  ipcMain.handle('settings:test-shortcut', (_event, accelerator) => {
    const inUseByUs = accelerator === activeShortcuts.toggle || accelerator === activeShortcuts.detail;
    if (inUseByUs) return { ok: true, mine: true };
    try {
      if (!globalShortcut.register(accelerator, () => {})) return { ok: false, reason: 'ocupado' };
      globalShortcut.unregister(accelerator);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'invalido', detail: err.message };
    }
  });

  app.on('window-all-closed', (event) => event.preventDefault()); // vive na bandeja
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    usage.stop();
    transcripts.stop();
    updates.stop();
    if (pointerTimer) clearInterval(pointerTimer);
  });
}
