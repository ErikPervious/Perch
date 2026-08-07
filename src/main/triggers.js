'use strict';

/**
 * Decide quando a ilha desce sozinha.
 *
 * Regra que guia tudo: um aviso que aparece demais deixa de ser aviso. Cada
 * gatilho dispara UMA vez por janela de 5h, e ha um intervalo minimo entre
 * descidas automaticas.
 */

const THRESHOLDS = [50, 75, 90, 95];
const WEEKLY_THRESHOLDS = [75, 90];
const MIN_GAP_MS = 90_000;

// Ritmo so vira alerta se for anormal *e* levar a estourar antes do reset.
const ANOMALY_RATIO = 2.5;
const ANOMALY_MIN_BURN = 0.15; // %/min -- abaixo disso e ruido
const ANOMALY_MAX_MINUTES = 60; // so avisa se o estouro estiver perto

class TriggerEngine {
  constructor() {
    this.fired = new Set();
    this.windowKey = null;
    this.lastAlertAt = 0;
    this.lastAnomalyAt = 0;
  }

  /**
   * Nova janela de 5h.
   *
   * O `prime` e o detalhe que importa: os degraus que a janela JA passou sao
   * marcados como disparados sem alertar. Sem isso, abrir o app com a sessao
   * em 85% dispararia 50% e 75% retroativamente -- avisos sobre um passado que
   * voce nao pode mais mudar. Numa janela de verdade nova o uso e ~0, entao
   * nada e marcado e todos os degraus continuam valendo.
   */
  rotateWindow(key, snapshot) {
    const previous = this.windowKey;
    this.windowKey = key;
    this.fired.clear();

    for (const step of THRESHOLDS) {
      if (snapshot.fiveHour.used >= step) this.fired.add(`5h:${step}`);
    }
    if (snapshot.sevenDay) {
      for (const step of WEEKLY_THRESHOLDS) {
        if (snapshot.sevenDay.used >= step) this.fired.add(`7d:${step}`);
      }
    }

    return previous !== null && previous !== key;
  }

  evaluate(snapshot) {
    if (!snapshot.ok || !snapshot.fiveHour) return null;

    const now = Date.now();
    const key = String(snapshot.fiveHour.resetsAt || 'sem-reset');

    if (key !== this.windowKey) {
      const isRenewal = this.rotateWindow(key, snapshot);
      if (isRenewal) {
        this.lastAlertAt = now;
        return {
          kind: 'renewed',
          level: 'good',
          title: 'Sessão renovada',
          detail: 'Bloco de 5h zerado',
          value: snapshot.fiveHour.used,
        };
      }
      // Primeira leitura desta janela: so calibrou, nao alerta.
      return null;
    }

    if (now - this.lastAlertAt < MIN_GAP_MS) return null;

    const used = snapshot.fiveHour.used;

    // 1. Cruzou um degrau de porcentagem.
    for (const step of THRESHOLDS) {
      const tag = `5h:${step}`;
      if (used >= step && !this.fired.has(tag)) {
        this.fired.add(tag);
        this.lastAlertAt = now;
        return {
          kind: 'threshold',
          level: step >= 90 ? 'critical' : step >= 75 ? 'warning' : 'info',
          title: `${Math.round(used)}% da sessão`,
          detail: this.resetPhrase(snapshot),
          value: used,
        };
      }
    }

    // 2. Ritmo disparou. Este e o alerta que voce pediu: sobe rapido demais.
    const anomalous =
      snapshot.anomalyRatio >= ANOMALY_RATIO &&
      snapshot.burnPerMin >= ANOMALY_MIN_BURN &&
      snapshot.minutesToLimit !== null &&
      snapshot.minutesToLimit <= ANOMALY_MAX_MINUTES &&
      snapshot.willExhaust;

    if (anomalous && now - this.lastAnomalyAt > 10 * 60_000) {
      this.lastAnomalyAt = now;
      this.lastAlertAt = now;
      return {
        kind: 'burst',
        level: 'warning',
        title: 'Queimando rápido',
        detail: `${snapshot.burnPerMin.toFixed(1)}%/min · acaba em ~${Math.round(snapshot.minutesToLimit)}min`,
        value: used,
        shake: true,
      };
    }

    // 3. Limite semanal, que e o que realmente estraga a semana.
    if (snapshot.sevenDay) {
      for (const step of WEEKLY_THRESHOLDS) {
        const tag = `7d:${step}`;
        if (snapshot.sevenDay.used >= step && !this.fired.has(tag)) {
          this.fired.add(tag);
          this.lastAlertAt = now;
          return {
            kind: 'weekly',
            level: step >= 90 ? 'critical' : 'warning',
            title: `${Math.round(snapshot.sevenDay.used)}% da semana`,
            detail: 'Limite de 7 dias',
            value: snapshot.sevenDay.used,
          };
        }
      }
    }

    return null;
  }

  resetPhrase(snapshot) {
    const ms = snapshot.fiveHour.resetInMs;
    if (ms === null || ms === undefined) return 'sem previsão de reset';
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 60) return `renova em ${mins}min`;
    return `renova em ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
  }
}

module.exports = { TriggerEngine };
