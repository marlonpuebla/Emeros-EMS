'use strict';
const path = require('path');
const fs   = require('fs');

// ── Load data/config.env if present ─────────────────────────────────
(function loadConfigEnv() {
  try {
    const cf = path.join(__dirname, 'data', 'config.env');
    const lines = fs.readFileSync(cf, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    console.log('[config] Loaded data/config.env');
  } catch { /* no config.env — rely on process.env */ }
})();

const VERSION    = '2.0.0';
const PORT       = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'ems-change-me-in-production';
const DATA_DIR   = path.join(__dirname, 'data');
const DB_PATH    = path.join(DATA_DIR, 'ems.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

module.exports = { VERSION, PORT, JWT_SECRET, DATA_DIR, DB_PATH, UPLOAD_DIR };
