'use strict';
const express = require('express');
const path    = require('path');
const cors    = require('cors');
const config  = require('./config');
const { initDb, dbAll, dbGet, dbRun, lastInsertId, saveDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

initDb().then(() => {
  // Attach db helpers to app.locals so routes can use them
  app.locals.dbAll       = dbAll;
  app.locals.dbGet       = dbGet;
  app.locals.dbRun       = dbRun;
  app.locals.lastInsertId = lastInsertId;
  app.locals.saveDb      = saveDb;

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

  app.listen(config.PORT, () => {
    console.log(`\nEmeros — Employee Management System  v${config.VERSION}`);
    console.log(`Running at http://localhost:${config.PORT}`);
    console.log(`Press Ctrl+C to stop.\n`);
  });
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
