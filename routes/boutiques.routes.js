// backend/routes/boutiques.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const {
  requirePermission,
  canAccessBoutique,
  getAccessibleBoutiques,
} = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════
function cleanId(value) {
  if (value === undefined || value === null || value === '' || value === 'null') return undefined;
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

function cleanStr(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '' || s === 'null' || s === 'undefined') return undefined;
  return s;
}

function cleanDate(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'all') return undefined;
  return s;
}

// ─────────────────────────────────────────────
// GET /api/boutiques
// Scoping automatique : gérant/agent ne voit que ses boutiques
// Accessible à TOUS les rôles connectés (avec scoping)
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 1000 }).toInt(),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('departement_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('gerant_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('is_active').optional({ values: 'falsy' }).isIn(['0', '1', 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const categoryId = cleanId(req.query.category_id);
    const departementId = cleanId(req.query.departement_id);
    const gerantId = cleanId(req.query.gerant_id);
    const search = cleanStr(req.query.search);
    const isActive = req.query.is_active;

    // Scoping RBAC : gérant/agent ne voit que son périmètre
    let allowedIds = null;
    if (req.user.role !== 'admin') {
      const accessible = await getAccessibleBoutiques(req.user);
      allowedIds = accessible.map((b) => b.id);
      if (allowedIds.length === 0) {
        return res.json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
        });
      }
    }

    const conditions = ['1=1'];
    const params = [];

    if (allowedIds) {
      conditions.push(`b.id IN (${allowedIds.map(() => '?').join(',')})`);
      params.push(...allowedIds);
    }
    if (categoryId) { conditions.push('b.category_id = ?'); params.push(categoryId); }
    if (departementId) { conditions.push('b.departement_id = ?'); params.push(departementId); }
    if (gerantId) { conditions.push('b.gerant_id = ?'); params.push(gerantId); }
    if (search) {
      conditions.push('(b.name LIKE ? OR b.address LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (isActive && isActive !== 'all') {
      const n = parseInt(isActive, 10);
      if (!isNaN(n)) {
        conditions.push('b.is_active = ?');
        params.push(n);
      }
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM boutiques b WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT
        b.*,
        c.name  AS category_name,
        c.color AS category_color,
        d.name  AS departement_name,
        u.fullname AS gerant_name,
        u.phone    AS gerant_phone,
        (SELECT COUNT(*) FROM produits WHERE boutique_id = b.id AND is_active = 1) AS nb_produits,
        (SELECT COUNT(*) FROM personnel WHERE boutique_id = b.id AND statut = 'actif') AS nb_personnel,
        (SELECT COALESCE(SUM(v.total_vente), 0)
         FROM ventes v
         JOIN commandes c2 ON v.commande_id = c2.id
         WHERE c2.boutique_id = b.id AND v.statut = 'validee') AS ca_total,
        (SELECT COALESCE(SUM(v.total_marge), 0)
         FROM ventes v
         JOIN commandes c2 ON v.commande_id = c2.id
         WHERE c2.boutique_id = b.id AND v.statut = 'validee') AS marge_total
       FROM boutiques b
       JOIN categories c ON b.category_id = c.id
       LEFT JOIN departements d ON b.departement_id = d.id
       LEFT JOIN users u ON b.gerant_id = u.id
       WHERE ${where}
       ORDER BY b.name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / limit),
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/boutiques/:id/stats
// ⚠️ DOIT ÊTRE AVANT /:id
// ─────────────────────────────────────────────
router.get(
  '/:id/stats',
  validate([
    param('id').isInt().toInt(),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const canAccess = await canAccessBoutique(req.user, targetId);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'BOUTIQUE_FORBIDDEN');

    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);

    const dateFilter = [];
    const params = [targetId];
    if (from) { dateFilter.push('AND date(v.created_at) >= date(?)'); params.push(from); }
    if (to)   { dateFilter.push('AND date(v.created_at) <= date(?)'); params.push(to); }

    const stats = await get(
      `SELECT
        COALESCE(SUM(v.total_vente), 0) AS ca,
        COALESCE(SUM(v.total_marge), 0) AS marge,
        COUNT(DISTINCT v.id) AS nb_ventes,
        COUNT(DISTINCT v.agent_id) AS nb_agents_actifs
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       WHERE c.boutique_id = ? AND v.statut = 'validee'
       ${dateFilter.join(' ')}`,
      params
    );

    const chargeParams = [targetId];
    let chargeFilter = '';
    if (from) { chargeFilter += ' AND date(date_charge) >= date(?)'; chargeParams.push(from); }
    if (to)   { chargeFilter += ' AND date(date_charge) <= date(?)'; chargeParams.push(to); }

    const charges = await get(
      `SELECT COALESCE(SUM(montant), 0) AS total
       FROM charges
       WHERE boutique_id = ? AND statut = 'validee'${chargeFilter}`,
      chargeParams
    );

    const evolution = await query(
      `SELECT
         strftime('%Y-%m-%d', v.created_at) AS period,
         COALESCE(SUM(v.total_vente), 0) AS ca,
         COALESCE(SUM(v.total_marge), 0) AS marge
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       WHERE c.boutique_id = ? AND v.statut = 'validee'
       ${dateFilter.join(' ')}
       GROUP BY period
       ORDER BY period ASC`,
      params
    );

    res.json({
      success: true,
      boutique_id: targetId,
      ca: stats.ca,
      marge: stats.marge,
      charges: charges.total,
      benefice_net: stats.marge - charges.total,
      nb_ventes: stats.nb_ventes,
      nb_agents_actifs: stats.nb_agents_actifs,
      evolution,
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/boutiques/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const canAccess = await canAccessBoutique(req.user, targetId);
    if (!canAccess) {
      throw new AppError('Accès non autorisé à cette boutique', 403, 'BOUTIQUE_FORBIDDEN');
    }

    const boutique = await get(
      `SELECT
        b.*,
        c.name AS category_name,
        c.color AS category_color,
        d.name AS departement_name,
        u.fullname AS gerant_name,
        u.phone    AS gerant_phone
       FROM boutiques b
       JOIN categories c ON b.category_id = c.id
       LEFT JOIN departements d ON b.departement_id = d.id
       LEFT JOIN users u ON b.gerant_id = u.id
       WHERE b.id = ?`,
      [targetId]
    );
    if (!boutique) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');

    const [produits, personnel, stats] = await Promise.all([
      query(
        `SELECT id, reference, name, prix_partenaire, prix_vente, marge_unitaire, stock, seuil_alerte
         FROM produits WHERE boutique_id = ? AND is_active = 1 ORDER BY name`,
        [targetId]
      ),
      query(
        `SELECT id, fullname, poste, statut FROM personnel
         WHERE boutique_id = ? ORDER BY fullname`,
        [targetId]
      ),
      get(
        `SELECT
           COALESCE(SUM(v.total_vente), 0) AS ca,
           COALESCE(SUM(v.total_marge), 0) AS marge,
           COUNT(DISTINCT v.id) AS nb_ventes
         FROM ventes v
         JOIN commandes c ON v.commande_id = c.id
         WHERE c.boutique_id = ? AND v.statut = 'validee'`,
        [targetId]
      ),
    ]);

    res.json({
      success: true,
      boutique: { ...boutique, produits, personnel, stats },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/boutiques — admin uniquement
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('boutiques', 'create'),
  validate([
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nom requis'),
    body('category_id').isInt().toInt().withMessage('Catégorie requise'),
    body('departement_id').optional({ values: 'falsy', nullable: true }).isInt().toInt(),
    body('gerant_id').optional({ values: 'falsy', nullable: true }).isInt().toInt(),
    body('address').optional({ values: 'falsy' }).trim().isLength({ max: 255 }),
    body('phone').optional({ values: 'falsy' }).trim().matches(/^\d{8}$/).withMessage('Téléphone 8 chiffres'),
  ]),
  asyncHandler(async (req, res) => {
    const { name, category_id, address, phone } = req.body;
    const departement_id = cleanId(req.body.departement_id);
    const gerant_id = cleanId(req.body.gerant_id);

    const category = await get('SELECT id FROM categories WHERE id = ? AND is_active = 1', [category_id]);
    if (!category) throw new AppError('Catégorie introuvable ou inactive', 404, 'CATEGORY_NOT_FOUND');

    if (departement_id) {
      const dep = await get('SELECT id FROM departements WHERE id = ? AND is_active = 1', [departement_id]);
      if (!dep) throw new AppError('Département introuvable ou inactif', 404, 'DEPARTEMENT_NOT_FOUND');
    }

    if (gerant_id) {
      const g = await get(
        `SELECT id, role FROM users WHERE id = ? AND is_active = 1 AND role IN ('gerant','admin')`,
        [gerant_id]
      );
      if (!g) throw new AppError('Gérant introuvable (rôle gérant/admin requis)', 404, 'GERANT_NOT_FOUND');
    }

    const result = await run(
      `INSERT INTO boutiques (name, category_id, departement_id, gerant_id, address, phone)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), category_id, departement_id || null, gerant_id || null, address || null, phone || null]
    );

    const boutique = await get('SELECT * FROM boutiques WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'BOUTIQUE_CREATED',
      resource: 'boutiques',
      resourceId: boutique.id,
      details: { name },
      ip: getClientIp(req),
    });

    res.status(201).json({ success: true, message: 'Boutique créée', boutique });
  })
);

// ─────────────────────────────────────────────
// PUT /api/boutiques/:id — admin + gérant (avec scoping)
// ─────────────────────────────────────────────
router.put(
  '/:id',
  requirePermission('boutiques', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('name').optional({ values: 'falsy' }).trim().isLength({ min: 2, max: 100 }),
    body('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('departement_id').optional({ values: 'falsy', nullable: true }).isInt().toInt(),
    body('gerant_id').optional({ values: 'falsy', nullable: true }).isInt().toInt(),
    body('address').optional({ values: 'falsy' }).trim().isLength({ max: 255 }),
    body('phone').optional({ values: 'falsy' }).trim().matches(/^\d{8}$/),
    body('is_active').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { name, category_id, address, phone, is_active } = req.body;
    const departement_id = cleanId(req.body.departement_id);
    const gerant_id = cleanId(req.body.gerant_id);

    // Scoping : un gérant ne peut modifier que ses boutiques
    const canAccess = await canAccessBoutique(req.user, targetId);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'BOUTIQUE_FORBIDDEN');

    const boutique = await get('SELECT * FROM boutiques WHERE id = ?', [targetId]);
    if (!boutique) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');

    // Un gérant ne peut pas se réassigner la boutique
    if (req.user.role === 'gerant' && gerant_id !== undefined && gerant_id !== boutique.gerant_id) {
      throw new AppError('Un gérant ne peut pas modifier le gérant assigné', 403, 'GERANT_CANNOT_REASSIGN');
    }

    if (category_id !== undefined) {
      const c = await get('SELECT id FROM categories WHERE id = ? AND is_active = 1', [category_id]);
      if (!c) throw new AppError('Catégorie introuvable', 404, 'CATEGORY_NOT_FOUND');
    }

    if (departement_id !== undefined && departement_id !== null) {
      const d = await get('SELECT id FROM departements WHERE id = ? AND is_active = 1', [departement_id]);
      if (!d) throw new AppError('Département introuvable', 404, 'DEPARTEMENT_NOT_FOUND');
    }

    if (gerant_id !== undefined && gerant_id !== null) {
      const g = await get(
        `SELECT id FROM users WHERE id = ? AND is_active = 1 AND role IN ('gerant','admin')`,
        [gerant_id]
      );
      if (!g) throw new AppError('Gérant introuvable', 404, 'GERANT_NOT_FOUND');
    }

    await run(
      `UPDATE boutiques SET
        name = COALESCE(?, name),
        category_id = COALESCE(?, category_id),
        departement_id = ?,
        gerant_id = ?,
        address = COALESCE(?, address),
        phone = COALESCE(?, phone),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        name,
        category_id,
        departement_id === undefined ? boutique.departement_id : departement_id,
        gerant_id === undefined ? boutique.gerant_id : gerant_id,
        address,
        phone,
        is_active === undefined ? boutique.is_active : (is_active ? 1 : 0),
        targetId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'BOUTIQUE_UPDATED',
      resource: 'boutiques',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM boutiques WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Boutique mise à jour', boutique: updated });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/boutiques/:id — admin uniquement
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('boutiques', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const boutique = await get('SELECT * FROM boutiques WHERE id = ?', [targetId]);
    if (!boutique) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');

    const produitsCount = await get(
      'SELECT COUNT(*) AS c FROM produits WHERE boutique_id = ? AND is_active = 1',
      [targetId]
    );
    if (produitsCount.c > 0) {
      throw new AppError(
        `Impossible : ${produitsCount.c} produit(s) actif(s) rattaché(s). Désactivez-les d'abord.`,
        409,
        'BOUTIQUE_HAS_PRODUITS'
      );
    }

    await run('UPDATE boutiques SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'BOUTIQUE_DELETED',
      resource: 'boutiques',
      resourceId: targetId,
      details: { name: boutique.name },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Boutique supprimée (désactivée)' });
  })
);

module.exports = router;