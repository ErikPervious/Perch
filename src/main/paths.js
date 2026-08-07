'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const LOCAL = process.env.LOCALAPPDATA || HOME;

const STATE_DIR = path.join(LOCAL, 'Perch');
// Nome anterior do app. Continua aqui so pra migrar quem ja tinha dados.
const LEGACY_STATE_DIR = path.join(LOCAL, 'claude-island');

/**
 * Traz state.json e config.json da pasta antiga, uma vez.
 *
 * Sem isto a troca de nome jogaria fora o historico de amostras -- e sao elas
 * que alimentam o ritmo e a projecao, que levam ~30min de uso pra ficarem
 * confiaveis de novo.
 */
function migrateLegacy() {
  try {
    if (!fs.existsSync(LEGACY_STATE_DIR) || LEGACY_STATE_DIR === STATE_DIR) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    for (const name of ['state.json', 'config.json']) {
      const from = path.join(LEGACY_STATE_DIR, name);
      const to = path.join(STATE_DIR, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch {
    // Migracao e conveniencia: se falhar, o app so comeca com dados novos.
  }
}

module.exports = {
  HOME,
  CLAUDE_DIR,
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  SETTINGS_FILE: path.join(CLAUDE_DIR, 'settings.json'),
  STATE_DIR,
  LEGACY_STATE_DIR,
  STATE_FILE: path.join(STATE_DIR, 'state.json'),
  CONFIG_FILE: path.join(STATE_DIR, 'config.json'),
  migrateLegacy,
};
