// backend/routes/admin-agents.routes.js
const express = require('express');
const { param, query: qv } = require('express-validator');
const router = express.Router();

const { get, query, run } = require('../database/db');
const { authenticateToken } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');

router.use(authenticateToken, requireAdmin);

// ═══════════════════════════════════════════════
// GET /api/admin/agents — liste des agents
// ═══════════════════════════════════════════════
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 200 }).toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('is_active').optional({ values: 'falsy' }).isIn(['0', '1', 'all']),
    qv('sort').optional({ values: 'falsy' }).isIn(['name', 'ventes', 'marge', 'recent']),
    qv('order').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const isActive = req.query.is_active;
    const sort = req.query.sort || 'name';
    const order = (req.query.order || 'asc').toUpperCase();

    const conditions = ["u.role = 'agent'"];
    const params = [];

    if (search) {
      conditions.push('(u.fullname LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (isActive && isActive !== 'all') {
      conditions.push('u.is_active = ?');
      params.push(parseInt(isActive, 10));
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(`SELECT COUNT(*) AS total FROM users u WHERE ${where}`, params);

    let orderBy = 'u.fullname ASC';
    if (sort === 'name') orderBy = `u.fullname ${order}`;
    else if (sort === 'recent') orderBy = `u.created_at ${order}`;
    else if (sort === 'ventes') orderBy = 'total_ventes DESC';
    else if (sort === 'marge') orderBy = 'total_marge DESC';

    const rows = await query(
      `SELECT
        u.id, u.phone, u.fullname, u.email, u.province, u.city,
        u.is_active, u.created_at, u.last_login,
        COALESCE((SELECT COUNT(*) FROM ventes v WHERE v.agent_id = u.id AND v.statut = 'validee'), 0) AS total_ventes,
        COALESCE((SELECT SUM(v.total_vente) FROM ventes v WHERE v.agent_id = u.id AND v.statut = 'validee'), 0) AS total_ca,
        COALESCE((SELECT SUM(v.total_marge) FROM ventes v WHERE v.agent_id = u.id AND v.statut = 'validee'), 0) AS total_marge,
        COALESCE((SELECT COUNT(DISTINCT c.boutique_id)
                  FROM ventes v JOIN commandes c ON v.commande_id = c.id
                  WHERE v.agent_id = u.id AND v.statut = 'validee'), 0) AS nb_boutiques
       FROM users u
       WHERE ${where}
       ORDER BY ${orderBy}
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
// GET /api/admin/agents/:id — détail d'un agent
// ═══════════════════════════════════════════════
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const agent = await get(
      `SELECT id, phone, fullname, email, province, city, address,
              is_active, kyc_level, last_login, created_at
       FROM users WHERE id = ? AND role = 'agent'`,
      [req.params.id]
    );
    if (!agent) throw new AppError('Agent introuvable', 404, 'AGENT_NOT_FOUND');

    // Stats globales
    const stats = await get(
      `SELECT
        COALESCE(SUM(v.total_vente), 0) AS total_ca,
        COALESCE(SUM(v.total_marge), 0) AS total_marge,
        COUNT(*) AS nb_ventes,
        CASE WHEN SUM(v.total_vente) > 0
             THEN ROUND(SUM(v.total_marge) * 100.0 / SUM(v.total_vente), 2)
             ELSE 0 END AS marge_pourcentage
       FROM ventes v
       WHERE v.agent_id = ? AND v.statut = 'validee'`,
      [req.params.id]
    );

    // Boutiques fréquentées
    const boutiques = await query(
      `SELECT b.id, b.name,
              COUNT(DISTINCT v.id) AS nb_ventes,
              COALESCE(SUM(v.total_vente), 0) AS ca,
              COALESCE(SUM(v.total_marge), 0) AS marge
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE v.agent_id = ? AND v.statut = 'validee'
       GROUP BY b.id
       ORDER BY ca DESC`,
      [req.params.id]
    );

    // Top produits
    const topProduits = await query(
      `SELECT p.id, p.name, p.reference,
              SUM(lc.quantite) AS quantite,
              SUM((lc.prix_vente_applique - lc.prix_partenaire_applique) * lc.quantite) AS marge,
              SUM(lc.prix_vente_applique * lc.quantite) AS ca
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       JOIN commandes c ON lc.commande_id = c.id
       JOIN ventes v ON v.commande_id = c.id
       WHERE v.agent_id = ? AND v.statut = 'validee'
       GROUP BY p.id
       ORDER BY ca DESC
       LIMIT 10`,
      [req.params.id]
    );

    // ✅ 10 dernières ventes (variable corrigée)
    const dernieresVentes = await query(
      `SELECT v.id, v.reference, v.total_vente, v.total_marge, v.created_at,
              c.reference AS commande_ref,
              b.name AS boutique_name,
              CASE WHEN v.total_vente > 0
                   THEN ROUND(v.total_marge * 100.0 / v.total_vente, 2)
                   ELSE 0 END AS marge_pourcentage
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE v.agent_id = ? AND v.statut = 'validee'
       ORDER BY v.created_at DESC
       LIMIT 10`,
      [req.params.id]
    );

    // Évolution 30 jours
    const evolution = await query(
      `SELECT strftime('%Y-%m-%d', v.created_at) AS period,
              COALESCE(SUM(v.total_vente), 0) AS ca,
              COALESCE(SUM(v.total_marge), 0) AS marge,
              COUNT(*) AS nb_ventes
       FROM ventes v
       WHERE v.agent_id = ? AND v.statut = 'validee'
         AND date(v.created_at) >= date('now', '-30 days')
       GROUP BY period
       ORDER BY period ASC`,
      [req.params.id]
    );

    res.json({
      success: true,
      agent,
      stats,
      boutiques,
      top_produits: topProduits,
      dernieres_ventes: dernieresVentes,  // ✅ corrigé
      evolution,
    });
  })
);

// ═══════════════════════════════════════════════
// PATCH /api/admin/agents/:id/toggle-active
// ═══════════════════════════════════════════════
router.patch(
  '/:id/toggle-active',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const target = await get(
      'SELECT id, is_active, fullname FROM users WHERE id = ? AND role = "agent"',
      [req.params.id]
    );
    if (!target) throw new AppError('Agent introuvable', 404, 'AGENT_NOT_FOUND');

    const newStatus = target.is_active === 1 ? 0 : 1;

    // ✅ run() pour les UPDATE (au lieu de query())
    await run(
      'UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, req.params.id]
    );

    res.json({
      success: true,
      message: `Agent ${newStatus ? 'activé' : 'désactivé'}`,
      is_active: newStatus,
    });
  })
);

module.exports = router;