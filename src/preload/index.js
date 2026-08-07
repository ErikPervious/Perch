'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Superficie minima entre main e renderer. `contextIsolation` fica ligado e o
 * renderer nao ve `require` -- ele so recebe dados e manda tres intencoes.
 */
contextBridge.exposeInMainWorld('island', {
  onState: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('island:state', handler);
    return () => ipcRenderer.removeListener('island:state', handler);
  },
  onActivity: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('island:activity', handler);
    return () => ipcRenderer.removeListener('island:activity', handler);
  },
  onCommand: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('island:command', handler);
    return () => ipcRenderer.removeListener('island:command', handler);
  },
  /** Posicao do cursor em toda a tela, nao so dentro da janela. */
  onPointer: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('island:pointer', handler);
    return () => ipcRenderer.removeListener('island:pointer', handler);
  },
  /** Liga o rastreio global do cursor so enquanto a ilha esta visivel. */
  setTracking: (value) => ipcRenderer.send('island:track', !!value),

  /**
   * Handshake. O main so manda `boot` e o primeiro estado depois disto.
   * Sem esse aperto de mao, `ready-to-show` podia disparar antes do modulo do
   * renderer registrar os listeners, e a mensagem de boot se perdia em silencio
   * -- uma vez sim, uma vez nao.
   */
  ready: () => ipcRenderer.send('island:renderer-ready'),

  /** Avisa o main se o cursor esta sobre a ilha (liga/desliga o click-through). */
  setInteractive: (value) => ipcRenderer.send('island:interactive', !!value),
  /** Pede pro main recolher a janela apos a animacao de saida terminar. */
  requestHide: () => ipcRenderer.send('island:hide'),
  openPanel: (which) => ipcRenderer.send('island:open-panel', which),
});
