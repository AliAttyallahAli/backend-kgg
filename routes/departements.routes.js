// backend/routes/departements.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// GET /api/departements
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('search').optional().trim().isLength({ max: 100 }),
    qv('responsable_id').optional().isInt().toInt(),
    qv('is_active').optional().isIn(['0', '1', 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const conditions = ['1=1'];
    const params = [];

    if (req.query.search) {
      conditions.push('d.name LIKE ?');
      params.push(`%${req.query.search}%`);
    }
    if (req.query.responsable_id !== undefined) {
      conditions.push('d.responsable_id = ?');
      params.push(req.query.responsable_id);
    }
    if (req.query.is_active && req.query.is_active !== 'all') {
      conditions.push('d.is_active = ?');
      params.push(parseInt(req.query.is_active, 10));
    }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT d.*,
              u.fullname AS responsable_name,
              u.phone    AS responsable_phone,
              (SELECT COUNT(*) FROM boutiques WHERE departement_id = d.id AND is_active = 1) AS nb_boutiques,
              (SELECT COUNT(*) FROM personnel WHERE departement_id = d.id AND statut = 'actif') AS nb_personnel
       FROM departements d
       LEFT JOIN users u ON d.responsable_id = u.id
       WHERE ${where}
       ORDER BY d.name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  })
);

// ─────────────────────────────────────────────
// GET /api/departements/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const departement = await get(
      `SELECT d.*, u.fullname AS responsable_name
       FROM departements d
       LEFT JOIN users u ON d.responsable_id = u.id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!departement) throw new AppError('Département introuvable', 404, 'DEPARTEMENT_NOT_FOUND');

    const boutiques = await query(
      `SELECT id, name, gerant_id FROM boutiques
       WHERE departement_id = ? AND is_active = 1 ORDER BY name`,
      [req.params.id]
    );
    const personnel = await query(
      `SELECT id, fullname, poste, statut FROM personnel
       WHERE departement_id = ? AND statut = 'actif' ORDER BY fullname`,
      [req.params.id]
    );

    res.json({
      success: true,
      departement: { ...departement, boutiques, personnel },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/departements
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('departements', 'create'),
  validate([
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nom requis'),
    body('description').optional().trim().isLength({ max: 500 }),
    body('responsable_id').optional({ nullable: true }).isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const { name, description, responsable_id } = req.body;

    const existing = await get('SELECT id FROM departements WHERE name = ?', [name]);
    if (existing) throw new AppError('Ce département existe déjà', 409, 'DEPARTEMENT_NAME_EXISTS');

    // Si responsable_id fourni, vérifier rôle (gerant ou admin)
    if (responsable_id) {
      const u = await get('SELECT id, role FROM users WHERE id = ? AND is_active = 1', [responsable_id]);
      if (!u) throw new AppError('Responsable introuvable ou inactif', 404, 'RESPONSABLE_NOT_FOUND');
      if (!['gerant', 'admin'].includes(u.role)) {
        throw new AppError('Le responsable doit être un gérant ou un admin', 400, 'RESPONSABLE_ROLE_INVALID');
      }
    }

    const result = await run(
      `INSERT INTO departements (name, description, responsable_id)
       VALUES (?, ?, ?)`,
      [name.trim(), description || null, responsable_id || null]
    );

    const departement = await get('SELECT * FROM departements WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'DEPARTEMENT_CREATED',
      resource: 'departements',
      resourceId: departement.id,
      details: { name },
      ip: getClientIp(req),
    });

    res.status(201).json({ success: true, message: 'Département créé', departement });
  })
);

// ─────────────────────────────────────────────
// PUT /api/departements/:id
// ─────────────────────────────────────────────
router.put(
  '/:id',
  requirePermission('departements', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('name').optional().trim().isLength({ min: 2, max: 100 }),
    body('description').optional().trim().isLength({ max: 500 }),
    body('responsable_id').optional({ nullable: true }).isInt().toInt(),
    body('is_active').optional().isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { name, description, responsable_id, is_active } = req.body;

    const departement = await get('SELECT * FROM departements WHERE id = ?', [targetId]);
    if (!departement) throw new AppError('Département introuvable', 404, 'DEPARTEMENT_NOT_FOUND');

    if (name && name !== departement.name) {
      const existing = await get('SELECT id FROM departements WHERE name = ? AND id != ?', [name, targetId]);
      if (existing) throw new AppError('Ce nom existe déjà', 409, 'DEPARTEMENT_NAME_EXISTS');
    }

    if (responsable_id) {
      const u = await get('SELECT id, role FROM users WHERE id = ? AND is_active = 1', [responsable_id]);
      if (!u) throw new AppError('Responsable introuvable ou inactif', 404, 'RESPONSABLE_NOT_FOUND');
      if (!['gerant', 'admin'].includes(u.role)) {
        throw new AppError('Le responsable doit être un gérant ou un admin', 400, 'RESPONSABLE_ROLE_INVALID');
      }
    }

    await run(
      `UPDATE departements SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        responsable_id = ?,
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        name,
        description,
        responsable_id === undefined ? departement.responsable_id : responsable_id,
        is_active === undefined ? departement.is_active : (is_active ? 1 : 0),
        targetId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'DEPARTEMENT_UPDATED',
      resource: 'departements',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM departements WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Département mis à jour', departement: updated });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/departements/:id
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('departements', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const departement = await get('SELECT * FROM departements WHERE id = ?', [targetId]);
    if (!departement) throw new AppError('Département introuvable', 404, 'DEPARTEMENT_NOT_FOUND');

    const boutiqueCount = await get(
      'SELECT COUNT(*) AS c FROM boutiques WHERE departement_id = ? AND is_active = 1',
      [targetId]
    );
    if (boutiqueCount.c > 0) {
      throw new AppError(
        `Impossible : ${boutiqueCount.c} boutique(s) rattachée(s)`,
        409,
        'DEPARTEMENT_HAS_BOUTIQUES'
      );
    }

    const personnelCount = await get(
      `SELECT COUNT(*) AS c FROM personnel WHERE departement_id = ? AND statut = 'actif'`,
      [targetId]
    );
    if (personnelCount.c > 0) {
      throw new AppError(
        `Impossible : ${personnelCount.c} personnel(s) actif(s)`,
        409,
        'DEPARTEMENT_HAS_PERSONNEL'
      );
    }

    await run('UPDATE departements SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'DEPARTEMENT_DELETED',
      resource: 'departements',
      resourceId: targetId,
      details: { name: departement.name },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Département supprimé (désactivé)' });
  })
);

module.exports = router;