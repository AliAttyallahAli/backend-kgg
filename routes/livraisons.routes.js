// backend/routes/livraisons.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requireAdmin, requireGerantOrAdmin, canAccessBoutique, getAccessibleBoutiques } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

// ═══════════════════════════════════════════════
// GET /api/livraisons — liste paginée + filtres
// ═══════════════════════════════════════════════
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 200 }).toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('statut').optional({ values: 'falsy' }).isIn(['en_cours', 'livree', 'echouee', 'annulee', 'all']),
    qv('livreur_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const statut = req.query.statut;
    const livreurId = req.query.livreur_id ? parseInt(req.query.livreur_id, 10) : undefined;
    const from = req.query.from;
    const to = req.query.to;

    const conditions = ['1=1'];
    const params = [];

    // Scoping pour gérant
    if (req.user.role === 'gerant') {
      const acc = await getAccessibleBoutiques(req.user);
      const ids = acc.map((b) => b.id);
      if (ids.length === 0) {
        return res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
      conditions.push(`c.boutique_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    if (search) {
      conditions.push('(li.reference LIKE ? OR li.adresse LIKE ? OR l.fullname LIKE ? OR c.reference LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (statut && statut !== 'all') {
      conditions.push('li.statut = ?');
      params.push(statut);
    }
    if (livreurId) {
      conditions.push('li.livreur_id = ?');
      params.push(livreurId);
    }
    if (from) {
      conditions.push('date(li.created_at) >= date(?)');
      params.push(from);
    }
    if (to) {
      conditions.push('date(li.created_at) <= date(?)');
      params.push(to);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM livraisons li
       JOIN commandes c ON li.commande_id = c.id
       JOIN livreurs l ON li.livreur_id = l.id
       WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT
        li.id, li.reference, li.adresse, li.destinataire, li.telephone,
        li.statut, li.frais, li.livree_at, li.echouee_raison, li.created_at,
        c.reference AS commande_ref,
        b.name AS boutique_name,
        l.id AS livreur_id, l.fullname AS livreur_name, l.phone AS livreur_phone, l.vehicle AS livreur_vehicle
       FROM livraisons li
       JOIN commandes c ON li.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       JOIN livreurs l ON li.livreur_id = l.id
       WHERE ${where}
       ORDER BY li.created_at DESC
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

// ═══════════════════════════════════════════════
// GET /api/livraisons/:id — détail
// ═══════════════════════════════════════════════
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const livraison = await get(
      `SELECT li.*, l.fullname AS livreur_name, l.phone AS livreur_phone,
              c.reference AS commande_ref, b.name AS boutique_name
       FROM livraisons li
       JOIN livreurs l ON li.livreur_id = l.id
       JOIN commandes c ON li.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE li.id = ?`,
      [req.params.id]
    );
    if (!livraison) throw new AppError('Livraison introuvable', 404, 'LIVRAISON_NOT_FOUND');

    res.json({ success: true, livraison });
  })
);

// ═══════════════════════════════════════════════
// PATCH /api/livraisons/:id/statut — marquer livrée / échouée
// ═══════════════════════════════════════════════
router.patch(
  '/:id/statut',
  requireGerantOrAdmin,
  validate([
    param('id').isInt().toInt(),
    body('statut').isIn(['livree', 'echouee']).withMessage('Statut invalide'),
    body('raison').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const { statut, raison } = req.body;

    const livraison = await get('SELECT * FROM livraisons WHERE id = ?', [req.params.id]);
    if (!livraison) throw new AppError('Livraison introuvable', 404, 'LIVRAISON_NOT_FOUND');
    if (livraison.statut !== 'en_cours') {
      throw new AppError('Cette livraison est déjà terminée', 400, 'INVALID_STATUS');
    }

    if (statut === 'livree') {
      await run(
        `UPDATE livraisons SET statut = 'livree', livree_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [req.params.id]
      );
    } else {
      await run(
        `UPDATE livraisons SET statut = 'echouee', echouee_raison = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [raison || 'Non précisée', req.params.id]
      );
    }

    await logAction({
      userId: req.user.userId,
      action: `LIVRAISON_${statut.toUpperCase()}`,
      resource: 'livraisons',
      resourceId: req.params.id,
      details: { raison },
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM livraisons WHERE id = ?', [req.params.id]);
    res.json({
      success: true,
      message: `Livraison marquée comme ${statut === 'livree' ? 'livrée' : 'échouée'}`,
      livraison: updated,
    });
  })
);

module.exports = router;