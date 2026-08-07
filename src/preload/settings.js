'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Superficie da janela de configuracao. Nada de `require` no renderer. */
contextBridge.exposeInMainWorld('settings', {
  /** Estado inicial: config atual, atalhos em vigor e os padroes de fabrica. */
  load: () => ipcRenderer.invoke('settings:get'),

  /** Grava um pedaco da config. O main mescla, persiste e reavisa todo mundo. */
  set: (patch) => ipcRenderer.send('settings:set', patch),

  /**
   * Testa um acelerador antes de gravar. O Windows nao tem API de consulta,
   * entao o main registra e desregistra na hora pra descobrir.
   */
  testShortcut: (accelerator) => ipcRenderer.invoke('settings:test-shortcut', accelerator),

  /** 'install' | 'force' | 'uninstall' -- mexe no statusLine do Claude Code. */
  bridge: (action) => ipcRenderer.invoke('settings:bridge', action),

  close: () => ipcRenderer.send('settings:close'),
  openDataFolder: () => ipcRenderer.send('settings:open-data'),

  /** Avisa quando a config muda por fora (bandeja, outro painel). */
  onChanged: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
});
