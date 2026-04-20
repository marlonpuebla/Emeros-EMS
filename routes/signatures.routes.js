'use strict';
const crypto = require('crypto');
const { auth, editorOrAbove, audit } = require('../middleware/auth');

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  // Save a digital signature
  app.post('/api/signatures', auth, editorOrAbove, (req, res) => {
    const { signer_name, signer_role, entity_type, entity_id, document_name, signature_data } = req.body;
    if (!signer_name || !entity_type || !entity_id || !document_name || !signature_data)
      return res.status(400).json({ error: 'signer_name, entity_type, entity_id, document_name, and signature_data are required' });

    // Generate SHA-256 hash for authentication/verification
    const hashInput = `${signer_name}|${entity_type}|${entity_id}|${document_name}|${new Date().toISOString()}|${req.user.username}`;
    const signature_hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || '';
    const ua = req.headers['user-agent'] || '';

    dbRun(
      `INSERT INTO digital_signatures
        (signer_name, signer_role, entity_type, entity_id, document_name,
         signature_data, signature_hash, ip_address, user_agent,
         signed_by_user_id, signed_by_username)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [signer_name, signer_role || null, entity_type, entity_id, document_name,
       signature_data, signature_hash, ip, ua.substring(0, 255),
       req.user.id, req.user.username]
    );
    const id = lastInsertId();

    audit(req, 'DIGITAL_SIGNATURE', entity_type, entity_id,
      { signer_name, document_name, hash: signature_hash.substring(0, 16) + '...' });

    res.status(201).json({
      id,
      signature_hash,
      verification_code: signature_hash.substring(0, 12).toUpperCase(),
      signed_at: new Date().toISOString(),
    });
  });

  // Get signatures for an entity (e.g., hiring package)
  app.get('/api/signatures/:entity_type/:entity_id', auth, (req, res) => {
    const sigs = dbAll(
      `SELECT id, signer_name, signer_role, document_name, signature_hash,
              signed_by_username, signed_at
       FROM digital_signatures
       WHERE entity_type=? AND entity_id=?
       ORDER BY signed_at DESC`,
      [req.params.entity_type, req.params.entity_id]
    );
    res.json(sigs);
  });

  // Get a single signature with full data (for rendering)
  app.get('/api/signatures/detail/:id', auth, (req, res) => {
    const sig = dbGet('SELECT * FROM digital_signatures WHERE id=?', [req.params.id]);
    if (!sig) return res.status(404).json({ error: 'Signature not found' });
    res.json(sig);
  });

  // Verify a signature by hash
  app.get('/api/signatures/verify/:hash', (req, res) => {
    const sig = dbGet(
      `SELECT id, signer_name, signer_role, entity_type, entity_id, document_name,
              signature_hash, ip_address, signed_by_username, signed_at
       FROM digital_signatures WHERE signature_hash=?`,
      [req.params.hash]
    );
    if (!sig) return res.json({ verified: false, error: 'Signature not found' });
    res.json({
      verified: true,
      signer_name: sig.signer_name,
      signer_role: sig.signer_role,
      document_name: sig.document_name,
      signed_by: sig.signed_by_username,
      signed_at: sig.signed_at,
      verification_code: sig.signature_hash.substring(0, 12).toUpperCase(),
      ip_address: sig.ip_address,
    });
  });

  // Verify by short code (first 12 chars of hash, case-insensitive)
  app.get('/api/signatures/verify-code/:code', (req, res) => {
    const code = (req.params.code || '').toLowerCase();
    const sigs = dbAll('SELECT * FROM digital_signatures');
    const match = sigs.find(s => s.signature_hash.substring(0, 12) === code);
    if (!match) return res.json({ verified: false, error: 'Verification code not found' });
    res.json({
      verified: true,
      signer_name: match.signer_name,
      signer_role: match.signer_role,
      document_name: match.document_name,
      entity_type: match.entity_type,
      entity_id: match.entity_id,
      signed_by: match.signed_by_username,
      signed_at: match.signed_at,
      verification_code: match.signature_hash.substring(0, 12).toUpperCase(),
    });
  });

  // Delete a signature (admin only)
  app.delete('/api/signatures/:id', auth, (req, res) => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });
    const sig = dbGet('SELECT * FROM digital_signatures WHERE id=?', [req.params.id]);
    if (!sig) return res.status(404).json({ error: 'Signature not found' });
    dbRun('DELETE FROM digital_signatures WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_SIGNATURE', sig.entity_type, sig.entity_id,
      { signer_name: sig.signer_name, document_name: sig.document_name });
    res.json({ success: true });
  });
};
