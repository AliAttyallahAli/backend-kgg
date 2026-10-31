// backend/routes/agent.routes.js
const express = require('express');
const { param, query: qv } = require('express-validator');
const router = express.Router();

const { get, query } = require('../database/db');
const { authenticateToken } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function cleanDate(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'all') return undefined;
  return s;
}

// ═══════════════════════════════════════════════
// GET /api/agent/me/ventes — ventes de l'agent
// ═══════════════════════════════════════════════
router.get(
  '/me/ventes',
  requireRole('agent', 'admin'),
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 200 }).toInt(),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('sort').optional({ values: 'falsy' }).isIn(['date', 'marge', 'vente']),
    qv('order').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const agentId = req.user.userId;
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const search = (req.query.search || '').trim();
    const boutiqueId = req.query.boutique_id ? parseInt(req.query.boutique_id, 10) : undefined;
    const categoryId = req.query.category_id ? parseInt(req.query.category_id, 10) : undefined;
    const sort = req.query.sort || 'date';
    const order = (req.query.order || 'desc').toUpperCase();

    const conditions = ['v.agent_id = ?', "v.statut = 'validee'"];
    const params = [agentId];

    if (from) { conditions.push('date(v.created_at) >= date(?)'); params.push(from); }
    if (to) { conditions.push('date(v.created_at) <= date(?)'); params.push(to); }
    if (search) {
      conditions.push('(v.reference LIKE ? OR c.reference LIKE ? OR b.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (boutiqueId) { conditions.push('c.boutique_id = ?'); params.push(boutiqueId); }
    if (categoryId) {
      conditions.push(`c.id IN (
        SELECT DISTINCT commande_id FROM lignes_commande lc
        JOIN produits p ON lc.produit_id = p.id WHERE p.category_id = ?
      )`);
      params.push(categoryId);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE ${where}`,
      params
    );

    // Tri dynamique
    let orderBy = 'v.created_at DESC';
    if (sort === 'date') orderBy = `v.created_at ${order}`;
    else if (sort === 'marge') orderBy = `v.total_marge ${order}`;
    else if (sort === 'vente') orderBy = `v.total_vente ${order}`;

    const rows = await query(
      `SELECT v.id, v.reference, v.total_vente, v.total_marge, v.created_at,
              c.reference AS commande_ref,
              b.name AS boutique_name,
              CASE WHEN v.total_vente > 0
                   THEN ROUND(v.total_marge * 100.0 / v.total_vente, 2)
                   ELSE 0 END AS marge_pourcentage,
              (SELECT COUNT(*) FROM lignes_commande WHERE commande_id = v.commande_id) AS nb_lignes
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
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
// GET /api/agent/me/stats — statistiques agrégées
// ═══════════════════════════════════════════════
router.get(
  '/me/stats',
  requireRole('agent', 'admin'),
  validate([
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('granularity').optional({ values: 'falsy' }).isIn(['day', 'week', 'month']),
  ]),
  asyncHandler(async (req, res) => {
    const agentId = req.user.userId;
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const granularity = req.query.granularity || 'day';

    const conditions = ["v.agent_id = ?", "v.statut = 'validee'"];
    const params = [agentId];

    if (from) { conditions.push('date(v.created_at) >= date(?)'); params.push(from); }
    if (to) { conditions.push('date(v.created_at) <= date(?)'); params.push(to); }

    const where = conditions.join(' AND ');

    // KPIs globaux
    const stats = await get(
      `SELECT
        COALESCE(SUM(v.total_vente), 0) AS total_vente,
        COALESCE(SUM(v.total_marge), 0) AS total_marge,
        COUNT(*) AS nb_ventes,
        CASE WHEN SUM(v.total_vente) > 0
             THEN ROUND(SUM(v.total_marge) * 100.0 / SUM(v.total_vente), 2)
             ELSE 0 END AS marge_pourcentage,
        ROUND(AVG(v.total_marge), 0) AS marge_moyenne
       FROM ventes v
       WHERE ${where}`,
      params
    );

    // Évolution par période
    let dateFormat = "strftime('%Y-%m-%d', v.created_at)";
    if (granularity === 'week') {
      dateFormat = "strftime('%Y-W%W', v.created_at)";
    } else if (granularity === 'month') {
      dateFormat = "strftime('%Y-%m', v.created_at)";
    }

    const evolution = await query(
      `SELECT
        ${dateFormat} AS period,
        COALESCE(SUM(v.total_vente), 0) AS ca,
        COALESCE(SUM(v.total_marge), 0) AS marge,
        COUNT(*) AS nb_ventes
       FROM ventes v
       WHERE ${where}
       GROUP BY period
       ORDER BY period ASC`,
      params
    );

    // Top 5 boutiques de l'agent
    const topBoutiques = await query(
      `SELECT b.id, b.name,
              COALESCE(SUM(v.total_vente), 0) AS ca,
              COALESCE(SUM(v.total_marge), 0) AS marge,
              COUNT(*) AS nb_ventes
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE ${where}
       GROUP BY b.id
       ORDER BY ca DESC
       LIMIT 5`,
      params
    );

    // Top 5 produits vendus
    const topProduits = await query(
      `SELECT p.id, p.name, p.reference,
              SUM(lc.quantite) AS quantite,
              SUM((lc.prix_vente_applique - lc.prix_partenaire_applique) * lc.quantite) AS marge,
              SUM(lc.prix_vente_applique * lc.quantite) AS ca
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       JOIN commandes c ON lc.commande_id = c.id
       JOIN ventes v ON v.commande_id = c.id
       WHERE ${where}
       GROUP BY p.id
       ORDER BY marge DESC
       LIMIT 5`,
      params
    );

    // Top 5 catégories
    const topCategories = await query(
      `SELECT cat.id, cat.name, cat.color,
              COALESCE(SUM(lc.prix_vente_applique * lc.quantite), 0) AS ca,
              COALESCE(SUM((lc.prix_vente_applique - lc.prix_partenaire_applique) * lc.quantite), 0) AS marge
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       JOIN categories cat ON p.category_id = cat.id
       JOIN commandes c ON lc.commande_id = c.id
       JOIN ventes v ON v.commande_id = c.id
       WHERE ${where}
       GROUP BY cat.id
       ORDER BY ca DESC
       LIMIT 5`,
      params
    );

    res.json({
      success: true,
      kpis: stats,
      evolution,
      top_boutiques: topBoutiques,
      top_produits: topProduits,
      top_categories: topCategories,
    });
  })
);

// ═══════════════════════════════════════════════
// GET /api/agent/me/ventes/:id — détail d'une vente
// ═══════════════════════════════════════════════
router.get(
  '/me/ventes/:id',
  requireRole('agent', 'admin'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const vente = await get(
      `SELECT v.*,
              c.reference AS commande_ref,
              b.name AS boutique_name, b.address AS boutique_address,
              vg.fullname AS valideur_name
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON v.valide_par = vg.id
       WHERE v.id = ? AND v.agent_id = ?`,
      [req.params.id, req.user.userId]
    );

    if (!vente) throw new AppError('Vente introuvable', 404, 'VENTE_NOT_FOUND');

    const lignes = await query(
      `SELECT lc.*,
              p.name AS produit_name,
              p.reference AS produit_ref,
              (lc.prix_vente_applique - lc.prix_partenaire_applique) AS marge_unitaire
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       WHERE lc.commande_id = ?`,
      [vente.commande_id]
    );

    res.json({
      success: true,
      vente: {
        ...vente,
        marge_pourcentage:
          vente.total_vente > 0
            ? Math.round((vente.total_marge / vente.total_vente) * 10000) / 100
            : 0,
        lignes,
      },
    });
  })
);

module.exports = router;