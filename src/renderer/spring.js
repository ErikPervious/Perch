'use strict';

/**
 * Integrador de mola.
 *
 * Por que nao usar transicao CSS: `cubic-bezier` interpola entre dois pontos
 * num tempo fixo. Mola nao tem duracao -- ela tem energia. Se o alvo muda no
 * meio do movimento, a velocidade atual e preservada e o movimento continua
 * sem "reiniciar". E dai que vem a sensacao de peso e o overshoot que a ilha
 * do iPhone tem.
 *
 * Integracao semi-implicita de Euler com passo fixo pequeno: estavel mesmo se
 * o navegador engasgar e entregar um dt grande.
 */

export const PRESETS = {
  // Abrir: macio, com um pouco de overshoot. E o movimento que chama atencao.
  grow: { stiffness: 210, damping: 21, mass: 1 },
  // Fechar: seco. Overshoot ao recolher parece bug, nao charme.
  shrink: { stiffness: 260, damping: 30, mass: 1 },
  // Descida vinda de fora da tela: mais solto, quica de leve ao chegar.
  drop: { stiffness: 190, damping: 17, mass: 1 },
  // Subida: rapido e sem quicar, some antes de voce reparar.
  retract: { stiffness: 300, damping: 34, mass: 1 },
  // Numeros e cores: sem quicar nunca.
  smooth: { stiffness: 150, damping: 26, mass: 1 },
  snappy: { stiffness: 420, damping: 32, mass: 1 },
};

const SUBSTEP = 1 / 240; // s
const REST_DELTA = 0.02;
const REST_SPEED = 0.02;

export class Spring {
  constructor(value = 0, preset = PRESETS.smooth) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.preset = preset;
    this.settled = true;
  }

  setPreset(preset) {
    this.preset = preset;
    return this;
  }

  /** Novo alvo, preservando a velocidade atual. */
  to(target, preset) {
    if (preset) this.preset = preset;
    if (target === this.target) return this;
    this.target = target;
    this.settled = false;
    return this;
  }

  /**
   * Empurrao instantaneo, sem mexer no alvo.
   * Uma mola com alvo 0 e amortecimento baixo vira pendulo: injeta velocidade
   * e ela oscila ate parar sozinha.
   */
  impulse(velocity) {
    this.velocity += velocity;
    this.settled = false;
    return this;
  }

  /** Teleporta: sem animacao, sem energia residual. */
  jump(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.settled = true;
    return this;
  }

  step(dt) {
    if (this.settled) return this.value;

    const { stiffness: k, damping: c, mass: m } = this.preset;
    // Trava o dt: alt-tab pode devolver um frame de varios segundos, e ai a
    // integracao explode.
    let remaining = Math.min(dt, 0.064);

    while (remaining > 0) {
      const h = Math.min(SUBSTEP, remaining);
      const force = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += (force / m) * h;
      this.value += this.velocity * h;
      remaining -= h;
    }

    if (Math.abs(this.value - this.target) < REST_DELTA && Math.abs(this.velocity) < REST_SPEED) {
      this.value = this.target;
      this.velocity = 0;
      this.settled = true;
    }

    return this.value;
  }
}

/**
 * Impulso amortecido: um empurrao que decai sozinho, sem alvo.
 * Usado no "tremor" quando o consumo dispara.
 */
export class Shake {
  constructor() {
    this.t = Infinity;
    this.amplitude = 0;
  }

  fire(amplitude = 7, duration = 0.6, frequency = 15) {
    this.t = 0;
    this.amplitude = amplitude;
    this.duration = duration;
    this.frequency = frequency;
  }

  step(dt) {
    if (this.t > (this.duration ?? 0)) return 0;
    this.t += dt;
    const decay = Math.exp(-this.t * 6);
    return Math.sin(this.t * this.frequency * Math.PI * 2) * this.amplitude * decay;
  }
}

/** Interpolacao linear entre duas cores hex. */
export function mixHex(a, b, t) {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}
