'use strict';
const { auth, editorOrAbove, adminOnly, audit } = require('../middleware/auth');
const EC = require('../services/email.service');

module.exports = function (app) {
  const { dbGet } = app.locals;

  app.get('/api/verify/:id', auth, editorOrAbove, async (req, res) => {
    const e = dbGet('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    try {
      const results = await EC.verifyEmployee(e);
      audit(req, 'VERIFY_CREDENTIALS', 'employees', e.id,
        { name: `${e.first_name} ${e.last_name}`, checks: Object.keys(results) });
      res.json({ employee_id: e.id, name: `${e.first_name} ${e.last_name}`, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/verify/npi/:npi', auth, editorOrAbove, async (req, res) => {
    try {
      const result = await EC.verifyNPI(req.params.npi, req.query.first, req.query.last);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/verify/license/:license', auth, editorOrAbove, async (req, res) => {
    try {
      const result = await EC.verifyFLLicense(req.params.license, req.query.first, req.query.last);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/verify/wc-exemption/:number', auth, editorOrAbove, async (req, res) => {
    const num = (req.params.number || '').trim();
    if (!num) return res.status(400).json({ error: 'Exemption number required' });
    try {
      const pageRes = await fetch('https://apps8.fldfs.com/proofofcoverage/Search.aspx', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Emeros/2.0)' },
      });
      const pageHtml = await pageRes.text();
      const vs  = (pageHtml.match(/id="__VIEWSTATE"\s+value="([^"]+)"/)          || [])[1] || '';
      const vsg = (pageHtml.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/) || [])[1] || '';
      const ev  = (pageHtml.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/)    || [])[1] || '';
      const cookies = (pageRes.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0]).join('; ');

      const body = new URLSearchParams({
        '__VIEWSTATE': vs, '__VIEWSTATEGENERATOR': vsg, '__EVENTVALIDATION': ev,
        'ctl00$ContentPlaceHolder1$txtExemptionNumber': num,
        'ctl00$ContentPlaceHolder1$btnSearch': 'Search',
      });
      const postRes = await fetch('https://apps8.fldfs.com/proofofcoverage/Search.aspx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; Emeros/2.0)',
          'Cookie': cookies, 'Referer': 'https://apps8.fldfs.com/proofofcoverage/Search.aspx' },
        body: body.toString(),
      });
      const html = await postRes.text();
      if (html.includes('No records found') || !html.includes('GridRow')) {
        return res.json({ found: false, url: 'https://apps8.fldfs.com/proofofcoverage/Search.aspx' });
      }
      const expMatch    = html.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      const statusMatch = html.match(/Active|Expired|Pending/i);
      const nameMatch   = html.match(/GridRow[^>]*>[\s\S]*?<td[^>]*>\s*([^<\s][^<]*?)\s*<\/td>/i);
      const expiration  = expMatch ? expMatch[1] : '';
      const status      = statusMatch ? statusMatch[0] : 'Active';
      const name        = nameMatch ? nameMatch[1].trim() : '';
      let expiration_date = '';
      if (expiration) {
        const [m,d,y] = expiration.split('/');
        if (m && d && y) expiration_date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      res.json({ found: true, name, expiration, expiration_date, status,
        url: 'https://apps8.fldfs.com/proofofcoverage/Search.aspx' });
    } catch (e) {
      res.status(502).json({ error: 'FL DFS lookup failed: ' + e.message,
        url: 'https://apps8.fldfs.com/proofofcoverage/Search.aspx' });
    }
  });
};
