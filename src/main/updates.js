'use strict';

/**
 * Verificação de nova versão.
 *
 * Esta é a **única** requisição de rede do app. Ela consulta a API pública de
 * releases do GitHub e não envia nada: nenhum identificador, nenhum dado de
 * uso, nenhuma credencial. É um GET anônimo no mesmo endereço que qualquer
 * pessoa abriria no navegador. Desligável em `config.checkUpdates`.
 *
 * Sem token de propósito: exigir um seria absurdo para checar versão. Isso
 * limita a 60 requisições por hora por IP, o que é folgado para uma checagem a
 * cada 6 horas -- e se estourar, o 403 é tratado como "não sei", não como erro.
 *
 * O sinal é **release publicada**, não commit na main. A main muda em qualquer
 * merge, inclusive de documentação, e não haveria binário novo para baixar.
 */

const { EventEmitter } = require('events');

const ENDPOINT = 'https://api.github.com/repos/ErikPervious/Perch/releases/latest';
const RELEASES_PAGE = 'https://github.com/ErikPervious/Perch/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20_000; // deixa a inicialização respirar
const TIMEOUT_MS = 8000;

/**
 * Compara duas versões no formato x.y.z.
 * @returns positivo se `a` for mais nova que `b`.
 */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p));

  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === undefined) return -1; // 1.0.0 < 1.0.0.1
    if (y === undefined) return 1;
    // Número ganha de rótulo: 1.0.1 é mais nova que 1.0.1-rc.
    if (typeof x === 'number' && typeof y === 'string') return 1;
    if (typeof x === 'string' && typeof y === 'number') return -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

class UpdateChecker extends EventEmitter {
  constructor(currentVersion) {
    super();
    this.current = currentVersion;
    this.latest = null; // { version, notes, url, publishedAt }
    this.lastCheckedAt = null;
    this.lastError = null;
    this._timer = null;
    this._first = null;
    this._running = false;
  }

  /** Estado para o painel e para a bandeja. */
  get state() {
    const available = this.latest && compareVersions(this.latest.version, this.current) > 0;
    return {
      current: this.current,
      latest: this.latest,
      available: !!available,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      page: RELEASES_PAGE,
    };
  }

  start() {
    this.stop();
    this._first = setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
    this._timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._first) clearTimeout(this._first);
    this._timer = null;
    this._first = null;
  }

  /** Nunca lança. Falha de rede é caminho normal aqui, não excecão. */
  async check() {
    if (this._running) return this.state;
    this._running = true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(ENDPOINT, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Perch/${this.current}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        // 403 costuma ser limite de requisições por IP. Não é erro do usuário.
        this.lastError = response.status === 403 ? 'limite-de-consultas' : `http-${response.status}`;
        return this.state;
      }

      const body = await response.json();
      const version = String(body.tag_name || '').replace(/^v/, '');
      if (!version) {
        this.lastError = 'resposta-inesperada';
        return this.state;
      }

      const previous = this.latest?.version;
      this.latest = {
        version,
        notes: typeof body.body === 'string' ? body.body : '',
        url: body.html_url || RELEASES_PAGE,
        publishedAt: body.published_at || null,
      };
      this.lastError = null;
      this.lastCheckedAt = Date.now();

      if (this.state.available && version !== previous) this.emit('available', this.state);
      return this.state;
    } catch (err) {
      this.lastError = err.name === 'AbortError' ? 'timeout' : 'rede';
      return this.state;
    } finally {
      clearTimeout(timer);
      this._running = false;
    }
  }
}

module.exports = { UpdateChecker, compareVersions, RELEASES_PAGE };
