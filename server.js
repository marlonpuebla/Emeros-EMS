'use strict';
const express = require('express');
const path    = require('path');
const cors    = require('cors');
const config  = require('./config');
const { initDb, dbAll, dbGet, dbRun, lastInsertId, saveDb, reloadDb } = require('./db');

const app = express();

// ── Security headers (no Helmet dependency needed) ───────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── CORS ─────────────────────────────────────────────────────
// Lock to specific origins via ALLOWED_ORIGIN in data/config.env.
// If not set, all origins are allowed (safe for local/intranet use).
if (config.ALLOWED_ORIGIN) {
  const allowed = config.ALLOWED_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (same-origin, mobile apps, curl)
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }));
  console.log(`[cors] Restricted to: ${allowed.join(', ')}`);
} else {
  app.use(cors());
  console.log('[cors] Open (set ALLOWED_ORIGIN in data/config.env to restrict)');
}

app.use(express.json());

// ── Health check (public, no auth) ───────────────────────────
// Used by Docker HEALTHCHECK / load balancers. Must stay unauthenticated
// so probes don't need a token. Reports OK once the process is serving.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: config.VERSION, uptime: process.uptime() });
});

app.use(express.static(path.join(__dirname, 'public')));

initDb().then(() => {
  // Attach db helpers to app.locals so routes can use them
  app.locals.dbAll       = dbAll;
  app.locals.dbGet       = dbGet;
  app.locals.dbRun       = dbRun;
  app.locals.lastInsertId = lastInsertId;
  app.locals.saveDb      = saveDb;
  app.locals.reloadDb    = reloadDb;

  // Register routes
  require('./routes/auth.routes')(app);
  require('./routes/users.routes')(app);
  require('./routes/employees.routes')(app);
  require('./routes/documents.routes')(app);
  require('./routes/reports.routes')(app);
  require('./routes/email.routes')(app);
  require('./routes/verify.routes')(app);
  require('./routes/recruiting.routes')(app);
  require('./routes/settings.routes')(app);
  require('./routes/hiring.routes')(app);
  require('./routes/payroll.routes')(app);
  require('./routes/signatures.routes')(app);
  require('./routes/idcard.routes')(app);
  require('./routes/access.routes')(app);
  require('./routes/audit.routes')(app);
  require('./routes/disciplinary.routes')(app);
  require('./routes/training.routes')(app);
  require('./routes/supervision.routes')(app);
  require('./routes/incidents.routes')(app);
  require('./routes/equipment.routes')(app);
  require('./routes/offboarding.routes')(app);
  require('./routes/compliance.routes')(app);

  // Start credential reminder scheduler
  const startScheduler = require('./services/scheduler.service');
  startScheduler(dbGet, dbAll, dbRun);

  // PWA — manifest and service worker
  app.get('/manifest.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
  });
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
  });

  // Catch-all — SPA
  app.use((req, res) => {
    if (req.path.startsWith('/api/'))
      return res.status(404).json({ error: 'API endpoint not found' });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Global error handler — always return JSON for API routes so the browser
  // never receives an HTML 500 page when a route handler throws.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    console.error(`[error] ${req.method} ${req.path} →`, err.message || err);
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: err.message || 'Internal server error' });
    }
    res.status(status).sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(config.PORT, () => {
    console.log(`\nEmeros — Employee Management System  v${config.VERSION}`);
    console.log(`Running at http://localhost:${config.PORT}`);
    console.log(`Press Ctrl+C to stop.\n`);
  });
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
