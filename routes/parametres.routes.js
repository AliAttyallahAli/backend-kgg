// backend/routes/parametres.routes.js
const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// GET /api/parametres — liste (admin)
// ─────────────────────────────────────────────
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await query('SELECT * FROM app_settings ORDER BY key ASC');
    const map = {};
    rows.forEach((r) => {
      map[r.key] = {
        value: r.value,
        type: r.type,
        updated_at: r.updated_at,
      };
    });
    res.json({ success: true, data: rows, map });
  })
);

// ─────────────────────────────────────────────
// GET /api/parametres/:key — lecture publique (une clé)
// ─────────────────────────────────────────────
router.get(
  '/:key',
  validate([param('key').isLength({ min: 1, max: 100 })]),
  asyncHandler(async (req, res) => {
    const row = await get('SELECT * FROM app_settings WHERE key = ?', [req.params.key]);
    if (!row) throw new AppError('Paramètre introuvable', 404, 'SETTING_NOT_FOUND');
    res.json({ success: true, key: row.key, value: row.value, type: row.type });
  })
);

// ─────────────────────────────────────────────
// PUT /api/parametres/:key — mise à jour (admin)
// ─────────────────────────────────────────────
router.put(
  '/:key',
  requireAdmin,
  validate([
    param('key').isLength({ min: 1, max: 100 }),
    body('value').notEmpty().withMessage('Valeur requise'),
    body('type').optional().isIn(['string', 'number', 'boolean', 'json']),
  ]),
  asyncHandler(async (req, res) => {
    const { value, type } = req.body;

    const existing = await get('SELECT * FROM app_settings WHERE key = ?', [req.params.key]);

    if (existing) {
      await run(
        `UPDATE app_settings SET value = ?, type = COALESCE(?, type),
         updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?`,
        [String(value), type || null, req.user.userId, req.params.key]
      );
    } else {
      await run(
        `INSERT INTO app_settings (key, value, type, updated_by) VALUES (?, ?, ?, ?)`,
        [req.params.key, String(value), type || 'string', req.user.userId]
      );
    }

    await logAction({
      userId: req.user.userId,
      action: 'SETTING_UPDATED',
      resource: 'app_settings',
      resourceId: req.params.key,
      details: { value },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Paramètre mis à jour' });
  })
);

module.exports = router;