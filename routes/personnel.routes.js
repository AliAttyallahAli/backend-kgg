// backend/routes/personnel.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requirePermission, canAccessBoutique, getAccessibleBoutiques } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// GET /api/personnel
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    qv('search').optional().trim().isLength({ max: 100 }),
    qv('departement_id').optional().isInt().toInt(),
    qv('boutique_id').optional().isInt().toInt(),
    qv('statut').optional().isIn(['actif', 'suspendu', 'sorti', 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    // Scoping
    let allowedBoutiqueIds = null;
    if (req.user.role !== 'admin') {
      const acc = await getAccessibleBoutiques(req.user);
      allowedBoutiqueIds = acc.map((b) => b.id);
      if (allowedBoutiqueIds.length === 0) {
        return res.json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
        });
      }
    }

    const conditions = ['1=1'];
    const params = [];

    if (allowedBoutiqueIds) {
      conditions.push(`(p.boutique_id IN (${allowedBoutiqueIds.map(() => '?').join(',')}) OR p.boutique_id IS NULL)`);
      params.push(...allowedBoutiqueIds);
    }
    if (req.query.departement_id) { conditions.push('p.departement_id = ?'); params.push(req.query.departement_id); }
    if (req.query.boutique_id) { conditions.push('p.boutique_id = ?'); params.push(req.query.boutique_id); }
    if (req.query.statut && req.query.statut !== 'all') {
      conditions.push('p.statut = ?'); params.push(req.query.statut);
    }
    if (req.query.search) {
      conditions.push('(p.fullname LIKE ? OR p.phone LIKE ? OR p.poste LIKE ?)');
      const s = `%${req.query.search}%`;
      params.push(s, s, s);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(`SELECT COUNT(*) AS total FROM personnel p WHERE ${where}`, params);

    const rows = await query(
      `SELECT p.*,
              d.name AS departement_name,
              b.name AS boutique_name,
              u.phone AS user_phone,
              (SELECT COALESCE(SUM(montant), 0) FROM paiements_personnel WHERE personnel_id = p.id) AS total_paye
       FROM personnel p
       LEFT JOIN departements d ON p.departement_id = d.id
       LEFT JOIN boutiques b ON p.boutique_id = b.id
       LEFT JOIN users u ON p.user_id = u.id
       WHERE ${where}
       ORDER BY p.fullname ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: {
        page, limit,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / limit),
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/personnel/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const m = await get(
      `SELECT p.*,
              d.name AS departement_name,
              b.name AS boutique_name,
              u.phone AS user_phone
       FROM personnel p
       LEFT JOIN departements d ON p.departement_id = d.id
       LEFT JOIN boutiques b ON p.boutique_id = b.id
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (!m) throw new AppError('Personnel introuvable', 404, 'PERSONNEL_NOT_FOUND');

    // Scoping
    if (req.user.role !== 'admin' && m.boutique_id) {
      const ok = await canAccessBoutique(req.user, m.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'PERSONNEL_FORBIDDEN');
    }

    const paiements = await query(
      `SELECT * FROM paiements_personnel WHERE personnel_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );

    const totalPaye = paiements.reduce((s, p) => s + (p.montant || 0), 0);

    res.json({
      success: true,
      personnel: { ...m, paiements, total_paye: totalPaye },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/personnel
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('personnel', 'create'),
  validate([
    body('fullname').trim().isLength({ min: 3, max: 100 }).withMessage('Nom complet requis'),
    body('phone').optional().trim().matches(/^\d{8}$/).withMessage('Téléphone 8 chiffres'),
    body('email').optional({ checkFalsy: true }).isEmail(),
    body('poste').trim().isLength({ min: 2, max: 100 }).withMessage('Poste requis'),
    body('departement_id').optional({ nullable: true }).isInt().toInt(),
    body('boutique_id').optional({ nullable: true }).isInt().toInt(),
    body('type_contrat').optional().isIn(['CDI', 'CDD', 'stage', 'freelance']),
    body('date_embauche').optional().isISO8601(),
    body('salaire_base').optional().isInt({ min: 0 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const {
      fullname, phone, email, poste, departement_id, boutique_id,
      type_contrat, date_embauche, salaire_base,
    } = req.body;

    // Scoping boutique
    if (boutique_id) {
      const b = await get('SELECT id FROM boutiques WHERE id = ? AND is_active = 1', [boutique_id]);
      if (!b) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');
      const ok = await canAccessBoutique(req.user, boutique_id);
      if (!ok) throw new AppError('Accès non autorisé à cette boutique', 403, 'BOUTIQUE_FORBIDDEN');
    }

    if (departement_id) {
      const d = await get('SELECT id FROM departements WHERE id = ? AND is_active = 1', [departement_id]);
      if (!d) throw new AppError('Département introuvable', 404, 'DEPARTEMENT_NOT_FOUND');
    }

    const result = await run(
      `INSERT INTO personnel
       (fullname, phone, email, poste, departement_id, boutique_id,
        type_contrat, date_embauche, salaire_base, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'actif')`,
      [
        fullname.trim(), phone || null, email || null, poste.trim(),
        departement_id || null, boutique_id || null,
        type_contrat || 'CDI',
        date_embauche || new Date().toISOString().slice(0, 10),
        salaire_base || 0,
      ]
    );

    const personnel = await get('SELECT * FROM personnel WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'PERSONNEL_CREATED',
      resource: 'personnel',
      resourceId: personnel.id,
      details: { fullname, poste },
      ip: getClientIp(req),
    });

    res.status(201).json({ success: true, message: 'Personnel créé', personnel });
  })
);

// ─────────────────────────────────────────────
// PUT /api/personnel/:id
// ─────────────────────────────────────────────
router.put(
  '/:id',
  requirePermission('personnel', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('fullname').optional().trim().isLength({ min: 3, max: 100 }),
    body('phone').optional({ nullable: true }).trim().matches(/^\d{8}$/),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('poste').optional().trim().isLength({ min: 2, max: 100 }),
    body('departement_id').optional({ nullable: true }).isInt().toInt(),
    body('boutique_id').optional({ nullable: true }).isInt().toInt(),
    body('type_contrat').optional().isIn(['CDI', 'CDD', 'stage', 'freelance']),
    body('date_embauche').optional().isISO8601(),
    body('salaire_base').optional().isInt({ min: 0 }).toInt(),
    body('statut').optional().isIn(['actif', 'suspendu', 'sorti']),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const m = await get('SELECT * FROM personnel WHERE id = ?', [targetId]);
    if (!m) throw new AppError('Personnel introuvable', 404, 'PERSONNEL_NOT_FOUND');

    if (req.user.role !== 'admin' && m.boutique_id) {
      const ok = await canAccessBoutique(req.user, m.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'PERSONNEL_FORBIDDEN');
    }

    // Gérant ne peut pas modifier le salaire (seul admin)
    if (req.user.role === 'gerant' && req.body.salaire_base !== undefined) {
      throw new AppError('Seul un admin peut modifier le salaire de base', 403, 'GERANT_CANNOT_EDIT_SALARY');
    }

    await run(
      `UPDATE personnel SET
        fullname = COALESCE(?, fullname),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        poste = COALESCE(?, poste),
        departement_id = ?,
        boutique_id = ?,
        type_contrat = COALESCE(?, type_contrat),
        date_embauche = COALESCE(?, date_embauche),
        salaire_base = COALESCE(?, salaire_base),
        statut = COALESCE(?, statut),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        req.body.fullname, req.body.phone, req.body.email, req.body.poste,
        req.body.departement_id === undefined ? m.departement_id : req.body.departement_id,
        req.body.boutique_id === undefined ? m.boutique_id : req.body.boutique_id,
        req.body.type_contrat, req.body.date_embauche, req.body.salaire_base,
        req.body.statut, targetId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PERSONNEL_UPDATED',
      resource: 'personnel',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM personnel WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Personnel mis à jour', personnel: updated });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/personnel/:id — soft delete
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('personnel', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const m = await get('SELECT * FROM personnel WHERE id = ?', [targetId]);
    if (!m) throw new AppError('Personnel introuvable', 404, 'PERSONNEL_NOT_FOUND');

    await run(`UPDATE personnel SET statut = 'sorti', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'PERSONNEL_DELETED',
      resource: 'personnel',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Personnel marqué comme "sorti"' });
  })
);

module.exports = router;