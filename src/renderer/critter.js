'use strict';

import { Spring, PRESETS } from './spring.js';

/* =========================================================================
   O bicho.

   Fica pendurado na borda de cima da tela, de cabeca para baixo, ao lado da
   ilha. A ideia e "espiar": so a metade de baixo dos olhos e a coroa da cabeca
   descem pra dentro da tela, como quem olha por cima de um parapeito sem botar
   a cabeca toda pra fora. O resto do corpo fica acima da borda, cortado.

   Se o cursor chega perto, ele se recolhe e espera um tempinho antes de voltar
   a espiar -- e timido.

   Ele nao e enfeite: o humor carrega estado.
     sonolento  sem sessao gerando ha mais de 1 min
     normal     tocando o barco
     atento     Claude gerando agora
     alarmado   acima de 85% do bloco, ou alerta critico na tela
   ========================================================================= */

const MOOD = {
  // `lid` mais alto que o intuitivo no sonolento de proposito: com o bicho
  // espiando, so a metade de baixo do olho esta na tela, e fechar demais nao
  // le como "sonolento" -- le como olho cortado.
  sleepy: { lid: 0.7, pupil: 2.3, sway: 0.6, blinkEvery: [4500, 9000] },
  normal: { lid: 1, pupil: 2.6, sway: 1.5, blinkEvery: [2600, 6500] },
  keen: { lid: 1, pupil: 2.35, sway: 2.6, blinkEvery: [1800, 4200] },
  alarmed: { lid: 1.18, pupil: 3.3, sway: 3.4, blinkEvery: [1100, 2600] },
};

// Geometria dos olhos em unidades de viewBox (que sao pixels: o SVG e 48x48
// e o elemento em CSS tambem). Precisa bater com o markup em index.html.
const EYE_CY = 25;
const EYE_RX = 5.8;
const EYE_RY = 6.6;
const EYE_MARGIN = 0.5; // fresta de branco que sempre sobra na borda

/**
 * Ponto em torno do qual a palpebra encolhe.
 *
 * Encolher pelo CENTRO do olho seria o intuitivo, mas o centro esta exatamente
 * na borda da tela (PEEK_Y = -EYE_CY): fechar comeria justamente a metade que
 * aparece, e o olho sumia num risco fino com a pupila maior que a fresta.
 *
 * Deslocando o pivo pra baixo, o fechamento come primeiro a metade que ja esta
 * fora da tela. A piscada continua visivel -- vira uma linha fina em vez de
 * nada -- e o sonolento mantem olho suficiente pra caber pupila.
 */
const LID_PIVOT = EYE_CY + EYE_RY * 0.5;

// Deslocamento vertical do elemento inteiro. Como o topo da janela corta o que
// sobe, isto controla quanto do bicho aparece.
//
// Espiando: -EYE_CY poe o CENTRO do olho exatamente na borda da tela, entao so
// a metade de baixo dele desce -- que e o jeito que a gente espia por cima de
// um parapeito, sem botar a cabeca toda pra fora.
// Escondido: tudo acima da borda, sem fade; some por posicao.
const PEEK_Y = -EYE_CY;
const HIDE_Y = -54;

const SCARE_RADIUS = 96; // px: a partir daqui ele foge
const SHY_COOLDOWN = 0.9; // s que ele espera antes de voltar a espiar

const GAZE_SATURATION = 150; // px de distancia em que a pupila ja foi ao limite
const PENDULUM = { stiffness: 88, damping: 7.5, mass: 1 }; // solto de proposito

/**
 * Deslocamento horizontal em relacao a borda direita da ilha.
 * Tem que bater com o `--critter-dx` no style.css -- se um mudar sem o outro,
 * ele passa a olhar torto.
 */
export const CRITTER_OFFSET_X = 44;

export class Critter {
  constructor(root) {
    this.root = root;
    this.pupils = [...root.querySelectorAll('[data-critter="pupil"]')];
    this.lids = [...root.querySelectorAll('[data-critter="lid"]')];

    this.rot = new Spring(0, PENDULUM);
    this.peek = new Spring(HIDE_Y, PRESETS.retract);
    this.gaze = { x: new Spring(0, PRESETS.smooth), y: new Spring(0, PRESETS.smooth) };
    this.lid = new Spring(1, PRESETS.smooth);
    this.pupilSize = new Spring(MOOD.normal.pupil, PRESETS.smooth);

    this.mood = 'normal';
    this.blinkAt = 2500;
    this.clock = 0;
    this.blinkPhase = null;
    this.pendingBlink = 0;

    this.enabled = true;
    this.shy = true;
    this.wanted = false; // deveria estar espiando?
    this.scaredUntil = -1;
  }

  setEnabled(value) {
    this.enabled = value;
    this.root.style.display = value ? '' : 'none';
  }

  setShy(value) {
    this.shy = value;
  }

  /** Chamado quando a ilha aparece/some, ou quando "espiar sozinho" muda. */
  setPeeking(value) {
    this.wanted = value;
  }

  /** Recolhido e parado: quem cuida do loop de RAF pode dormir. */
  get resting() {
    return this.peek.settled && this.peek.value <= HIDE_Y + 0.5;
  }

  setMood(mood) {
    if (mood === this.mood || !MOOD[mood]) return;
    this.mood = mood;
    const spec = MOOD[mood];
    this.lid.to(spec.lid, PRESETS.smooth);
    this.pupilSize.to(spec.pupil, PRESETS.grow);
    this.scheduleBlink();
    // Trocar de humor merece uma reacao: um susto empurra o pendulo.
    if (mood === 'alarmed') this.rot.impulse(26);
  }

  scheduleBlink() {
    const [min, max] = MOOD[this.mood].blinkEvery;
    this.blinkAt = this.clock + (min + Math.random() * (max - min)) / 1000;
  }

  /** Chamado quando a ilha muda de estado: o bicho sente o tranco. */
  nudge(strength) {
    this.rot.impulse(strength);
  }

  /**
   * @param dt      delta em segundos
   * @param pointer posicao do cursor, em px relativos a janela
   * @param anchorX centro horizontal da cabeca, em px da janela
   */
  step(dt, pointer, anchorX) {
    if (!this.enabled) return;
    this.clock += dt;

    // --- esconder / espiar
    const headY = this.peek.value + EYE_CY;
    const distance = Math.hypot(pointer.x - anchorX, pointer.y - headY);
    if (this.shy && distance < SCARE_RADIUS) this.scaredUntil = this.clock + SHY_COOLDOWN;

    const scared = this.clock < this.scaredUntil;
    const peeking = this.wanted && !scared;
    // Fugir e rapido; voltar a espiar e devagar, meio desconfiado.
    this.peek.to(peeking ? PEEK_Y : HIDE_Y, peeking ? PRESETS.drop : PRESETS.retract);
    const peekY = this.peek.step(dt);
    this.root.style.setProperty('--critter-y', `${peekY.toFixed(2)}px`);

    // --- olhar
    //
    // A pupila anda NA DIRECAO do cursor. O bicho estar desenhado de
    // ponta-cabeca nao inverte nada: o SVG nao esta rotacionado, e um olho
    // aponta pro que olha independente da orientacao da cabeca.
    const pr = this.pupilSize.step(dt);
    // O alcance depende do tamanho atual da pupila -- dilatada, ela precisa
    // andar menos pra nao encostar na borda do branco.
    const maxX = Math.max(0, EYE_RX - pr - EYE_MARGIN);
    const maxY = Math.max(0, EYE_RY - pr - EYE_MARGIN);

    const dx = pointer.x - anchorX;
    const dy = pointer.y - (peekY + EYE_CY);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / GAZE_SATURATION);
    this.gaze.x.to((dx / dist) * reach * maxX);
    this.gaze.y.to((dy / dist) * reach * maxY);

    const gx = this.gaze.x.step(dt);
    const gy = this.gaze.y.step(dt);
    for (const pupil of this.pupils) {
      pupil.setAttribute('r', pr.toFixed(2));
      pupil.setAttribute('transform', `translate(${gx.toFixed(2)} ${gy.toFixed(2)})`);
    }

    // --- piscada
    if (this.blinkPhase === null && this.clock >= this.blinkAt) {
      this.blinkPhase = 0;
      // Uma em cada quatro e dupla -- e a irregularidade que parece vivo.
      this.pendingBlink = Math.random() < 0.25 ? 1 : 0;
    }
    let openness = this.lid.step(dt);
    if (this.blinkPhase !== null) {
      this.blinkPhase += dt / 0.13;
      if (this.blinkPhase >= 1) {
        this.blinkPhase = null;
        if (this.pendingBlink > 0) {
          this.pendingBlink -= 1;
          this.blinkAt = this.clock + 0.11;
        } else {
          this.scheduleBlink();
        }
      } else {
        openness *= 1 - Math.sin(Math.PI * this.blinkPhase) * 0.95;
      }
    }
    for (const lid of this.lids) {
      lid.setAttribute(
        'transform',
        `translate(0 ${LID_PIVOT}) scale(1 ${Math.max(0.02, openness).toFixed(3)}) translate(0 ${-LID_PIVOT})`,
      );
    }

    // --- pendulo: oscilacao da mola + uma respiracao lenta por cima
    const swing = this.rot.step(dt);
    const idle = Math.sin(this.clock * 0.85) * MOOD[this.mood].sway;
    this.root.style.setProperty('--critter-rot', `${(swing + idle).toFixed(2)}deg`);
  }
}
