'use strict';
const path = require('path');
const fs   = require('fs');
const { auth, audit } = require('../middleware/auth');
const config = require('../config');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fileToDataUrl(filename) {
  if (!filename) return null;
  const p = path.join(config.UPLOAD_DIR, filename);
  if (!fs.existsSync(p)) return null;
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'svg' ? 'image/svg+xml'
    : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

module.exports = function (app) {
  const { dbGet } = app.locals;

  // GET /api/employees/:id/idcard — printable vertical CR80 badge HTML
  app.get('/api/employees/:id/idcard', auth, (req, res) => {
    const emp = dbGet(
      'SELECT id, first_name, last_name, badge_number, photo_url, position_ahca, position_om ' +
      'FROM employees WHERE id=?', [req.params.id]
    );
    if (!emp) return res.status(404).send('Employee not found');

    const orgRow = dbGet("SELECT value FROM app_settings WHERE key='org_name'");
    const logoRow = dbGet("SELECT value FROM app_settings WHERE key='org_logo_url'");
    const orgName = orgRow?.value || 'Emeros EMS';
    const photo = fileToDataUrl(emp.photo_url);
    const logo  = fileToDataUrl(logoRow?.value);
    const position = emp.position_om || emp.position_ahca || '';
    const fullName = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
    const badge = emp.badge_number || 'EMP-????';

    audit(req, 'PRINT_ID_CARD', 'employees', Number(req.params.id),
      { name: fullName, badge_number: badge });

    // Vertical CR80 card: 2.125" × 3.375" portrait
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ID Card — ${escapeHtml(fullName)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;background:#e5e7eb;padding:24px;display:flex;flex-direction:column;align-items:center;gap:16px}
  .card{
    width:2.125in;height:3.375in;background:#fff;border:1px solid #d1d5db;border-radius:10px;
    padding:10px;display:flex;flex-direction:column;align-items:center;
    box-shadow:0 4px 12px rgba(0,0,0,.18);position:relative;overflow:hidden;
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
  }
  /* Frosted slate gradient on the top 2/3 — decorative. */
  .card::before{
    content:"";position:absolute;left:0;right:0;top:0;height:66%;
    background:linear-gradient(to bottom,
      rgba(100,116,139,.22) 0%,
      rgba(148,163,184,.14) 45%,
      rgba(203,213,225,.06) 85%,
      rgba(255,255,255,0) 100%);
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
    border-radius:10px 10px 0 0;pointer-events:none;z-index:0;
  }
  /* Frosted-teal gradient at the bottom third — decorative. */
  .card::after{
    content:"";position:absolute;left:0;right:0;bottom:0;height:36%;
    background:linear-gradient(to top,
      rgba(13,148,136,.32) 0%,
      rgba(20,184,166,.22) 40%,
      rgba(45,212,191,.10) 75%,
      rgba(255,255,255,0) 100%);
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
    border-radius:0 0 10px 10px;pointer-events:none;z-index:0;
  }
  /* Washed-white logo watermark sits above gradients, below content. */
  .watermark{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    z-index:1;pointer-events:none;
  }
  .watermark img{
    width:150%;max-width:none;opacity:.32;
    filter:brightness(0) invert(1);
  }
  .card > *:not(.watermark){position:relative;z-index:2}
  .header{text-align:center;font-size:8.5px;font-weight:700;color:#0a5a3a;border-bottom:2px solid #0a5a3a;padding:2px 0 5px;width:100%;letter-spacing:.3px;line-height:1.15}
  .logo{max-height:40px;max-width:85%;object-fit:contain;display:block;margin:6px auto 4px}
  .photo{
    width:1.3in;height:1.3in;border:2px solid #0a5a3a;border-radius:6px;
    object-fit:cover;margin:6px 0;background:#f3f4f6;
  }
  .photo-placeholder{
    width:1.3in;height:1.3in;border:2px solid #0a5a3a;border-radius:6px;margin:6px 0;
    background:#f3f4f6;display:flex;align-items:center;justify-content:center;
  }
  .photo-placeholder svg{width:60%;height:60%;fill:#9ca3af}
  .name{font-size:11.5px;font-weight:700;text-align:center;color:#0f172a;margin-top:4px;line-height:1.15;padding:0 2px}
  .position{font-size:8.5px;color:#475569;text-align:center;margin:2px 2px 4px;line-height:1.15}
  .badge-num{font-size:10.5px;font-weight:700;color:#0a5a3a;margin-top:2px;letter-spacing:.5px}
  .barcode-wrap{
    margin-top:auto;width:100%;text-align:center;
    background:rgba(255,255,255,.88);border-radius:6px;padding:4px 6px;
    box-shadow:0 1px 2px rgba(0,0,0,.08);
  }
  .barcode-wrap svg{width:100%;height:34px}
  .btn-row{display:flex;gap:8px}
  .btn{padding:8px 18px;border:1px solid #0a5a3a;background:#0a5a3a;color:#fff;font-size:13px;cursor:pointer;border-radius:6px;font-family:inherit}
  .btn.secondary{background:#fff;color:#0a5a3a}
  .btn:hover{opacity:.9}
  @media print{
    body{background:#fff;padding:0;gap:0}
    .card{border:1px solid #888;box-shadow:none;border-radius:0}
    .btn-row{display:none}
    @page{size:2.125in 3.375in;margin:0}
  }
</style>
</head>
<body>
  <div class="card">
    ${logo ? `<div class="watermark"><img src="${logo}" alt=""></div>` : ''}
    <div class="header">${escapeHtml(orgName)}</div>
    ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
    ${photo
      ? `<img class="photo" src="${photo}" alt="">`
      : `<div class="photo-placeholder"><svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v3h16v-3c0-2.76-3.58-5-8-5z"/></svg></div>`}
    <div class="name">${escapeHtml(fullName)}</div>
    <div class="position">${escapeHtml(position)}</div>
    <div class="badge-num">${escapeHtml(badge)}</div>
    <div class="barcode-wrap"><svg id="bc"></svg></div>
  </div>
  <div class="btn-row">
    <button class="btn" onclick="window.print()">Print</button>
    <button class="btn secondary" onclick="downloadPng()">Download PNG (Bodno)</button>
    <button class="btn secondary" onclick="window.close()">Close</button>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.min.js"></script>
  <script>
    const BADGE = ${JSON.stringify(badge)};
    const SAFE_NAME = ${JSON.stringify(fullName.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, ''))};

    try {
      JsBarcode("#bc", BADGE, {
        format: "CODE128", height: 34, margin: 0, displayValue: false, width: 1.4
      });
    } catch (e) { console.error('Barcode render failed:', e); }

    // 300 DPI PNG at exact CR80 (2.125in x 3.375in = 638 x 1013 px).
    // Sized for import into Bodno ID Software.
    async function downloadPng() {
      const card = document.querySelector('.card');
      const btnRow = document.querySelector('.btn-row');
      const statusBtn = btnRow.querySelectorAll('button')[1];
      const origText = statusBtn.textContent;
      statusBtn.textContent = 'Rendering…';
      statusBtn.disabled = true;
      try {
        const pxWide = 638;
        const pxTall = 1013;
        const pixelRatio = pxWide / card.offsetWidth;
        const dataUrl = await htmlToImage.toPng(card, {
          width: card.offsetWidth,
          height: card.offsetHeight,
          pixelRatio,
          cacheBust: true,
          style: { margin: '0', boxShadow: 'none' },
        });
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'idcard_' + BADGE + (SAFE_NAME ? '_' + SAFE_NAME : '') + '.png';
        document.body.appendChild(a); a.click(); a.remove();
      } catch (e) {
        console.error('PNG export failed:', e);
        alert('Could not render PNG: ' + e.message);
      } finally {
        statusBtn.textContent = origText;
        statusBtn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
};
