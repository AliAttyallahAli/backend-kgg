// backend/routes/dashboards.routes.js
const express = require('express');
const { query: qv } = require('express-validator');
const router = express.Router();

const { get, query } = require('../database/db');
const { authenticateToken } = require('../middlewares/auth');
const { getAccessibleBoutiques } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler } = require('../middlewares/errorHandler');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// Utilitaire : filtre date réutilisable
// ─────────────────────────────────────────────
function buildDateFilter(from, to, column = 'created_at') {
  const parts = [];
  const params = [];
  if (from) { parts.push(`date(${column}) >= date(?)`); params.push(from); }
  if (to)   { parts.push(`date(${column}) <= date(?)`); params.push(to); }
  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

// ─────────────────────────────────────────────
// GET /api/dashboards/admin
// Vue globale consolidée
// ─────────────────────────────────────────────
router.get(
  '/admin',
  validate([
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      // Non-admin : renvoyer son dashboard dédié
      return res.status(403).json({ success: false, error: 'Réservé aux admins' });
    }

    const { from, to } = req.query;
    const dVente = buildDateFilter(from, to, 'v.created_at');
    const dCharge = buildDateFilter(from, to, 'ch.date_charge');
    const dPaie = buildDateFilter(from, to, 'pa.created_at');

    const [
      ventesStats,
      chargesStats,
      paiementsStats,
      stockStats,
      compteurs,
      topBoutiques,
      topProduits,
      evolutionVentes,
      evolutionCharges,
      parCategorie,
    ] = await Promise.all([
      // Ventes
      get(
        `SELECT
          COALESCE(SUM(v.total_vente), 0) AS ca,
          COALESCE(SUM(v.total_marge), 0) AS marge,
          COUNT(DISTINCT v.id) AS nb_ventes,
          COUNT(DISTINCT v.agent_id) AS nb_agents_actifs
        FROM ventes v
        WHERE v.statut = 'validee' ${dVente.sql}`,
        dVente.params
      ),
      // Charges
      get(
        `SELECT COUNT(*) AS nb, COALESCE(SUM(ch.montant), 0) AS total
         FROM charges ch WHERE ch.statut = 'validee' ${dCharge.sql}`,
        dCharge.params
      ),
      // Paiements personnel
      get(
        `SELECT COUNT(*) AS nb, COALESCE(SUM(pa.montant), 0) AS total
         FROM paiements_personnel pa WHERE 1=1 ${dPaie.sql}`,
        dPaie.params
      ),
      // Stock
      get(
        `SELECT
          COUNT(*) AS nb_produits,
          COALESCE(SUM(stock), 0) AS stock_total,
          SUM(CASE WHEN stock <= seuil_alerte THEN 1 ELSE 0 END) AS nb_alertes
        FROM produits WHERE is_active = 1`
      ),
      // Compteurs organisationnels
      get(
        `SELECT
          (SELECT COUNT(*) FROM boutiques WHERE is_active = 1) AS nb_boutiques,
          (SELECT COUNT(*) FROM categories WHERE is_active = 1) AS nb_categories,
          (SELECT COUNT(*) FROM departements WHERE is_active = 1) AS nb_departements,
          (SELECT COUNT(*) FROM users WHERE role = 'agent' AND is_active = 1) AS nb_agents,
          (SELECT COUNT(*) FROM users WHERE role = 'gerant' AND is_active = 1) AS nb_gerants,
          (SELECT COUNT(*) FROM personnel WHERE statut = 'actif') AS nb_personnel`
      ),
      // Top 5 boutiques par CA
      query(
        `SELECT b.id, b.name, c.color AS category_color,
                COALESCE(SUM(v.total_vente), 0) AS ca,
                COALESCE(SUM(v.total_marge), 0) AS marge
         FROM boutiques b
         JOIN categories c ON b.category_id = c.id
         LEFT JOIN commandes cmd ON cmd.boutique_id = b.id AND cmd.statut IN ('validee','livree')
         LEFT JOIN ventes v ON v.commande_id = cmd.id AND v.statut = 'validee'
         WHERE b.is_active = 1
         GROUP BY b.id
         ORDER BY ca DESC LIMIT 5`
      ),
      // Top 5 produits par marge
      query(
        `SELECT p.id, p.name, p.reference,
                COALESCE(SUM(lc.quantite), 0) AS quantite_vendue,
                COALESCE(SUM(lc.marge_calculee), 0) AS marge_totale
         FROM produits p
         LEFT JOIN lignes_commande lc ON lc.produit_id = p.id
         LEFT JOIN commandes cmd ON lc.commande_id = cmd.id AND cmd.statut IN ('validee','livree')
         WHERE p.is_active = 1
         GROUP BY p.id
         ORDER BY marge_totale DESC LIMIT 5`
      ),
      // Évolution CA/marge par jour (30 jours par défaut)
      query(
        `SELECT strftime('%Y-%m-%d', v.created_at) AS period,
                COALESCE(SUM(v.total_vente), 0) AS ca,
                COALESCE(SUM(v.total_marge), 0) AS marge
         FROM ventes v
         WHERE v.statut = 'validee' ${dVente.sql}
         GROUP BY period ORDER BY period ASC`,
        dVente.params
      ),
      // Évolution charges par jour
      query(
        `SELECT strftime('%Y-%m-%d', ch.date_charge) AS period,
                COALESCE(SUM(ch.montant), 0) AS total
         FROM charges ch
         WHERE ch.statut = 'validee' ${dCharge.sql}
         GROUP BY period ORDER BY period ASC`,
        dCharge.params
      ),
      // Répartition par catégorie
      query(
        `SELECT c.id, c.name, c.color,
                COALESCE(SUM(lc.prix_vente_applique * lc.quantite), 0) AS ca
         FROM categories c
         LEFT JOIN produits p ON p.category_id = c.id
         LEFT JOIN lignes_commande lc ON lc.produit_id = p.id
         LEFT JOIN commandes cmd ON lc.commande_id = cmd.id AND cmd.statut IN ('validee','livree')
         WHERE c.is_active = 1
         GROUP BY c.id ORDER BY ca DESC`
      ),
    ]);

    const beneficeNet = ventesStats.marge - chargesStats.total - paiementsStats.total;

    res.json({
      success: true,
      kpis: {
        ca_total: ventesStats.ca,
        marge_totale: ventesStats.marge,
        nb_ventes: ventesStats.nb_ventes,
        charges_totales: chargesStats.total,
        paiements_personnel: paiementsStats.total,
        benefice_net: beneficeNet,
        marge_pourcentage:
          ventesStats.ca > 0
            ? Math.round((ventesStats.marge / ventesStats.ca) * 10000) / 100
            : 0,
      },
      stock: stockStats,
      organisation: compteurs,
      top_boutiques: topBoutiques,
      top_produits: topProduits,
      evolution_ventes: evolutionVentes,
      evolution_charges: evolutionCharges,
      repartition_categories: parCategorie,
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/dashboards/gerant
// Vue périmètre (ses boutiques)
// ─────────────────────────────────────────────
router.get(
  '/gerant',
  validate([
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    if (!['admin', 'gerant'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Accès réservé aux gérants' });
    }

    const { from, to } = req.query;
    const accessible = await getAccessibleBoutiques(req.user);
    const ids = accessible.map((b) => b.id);

    if (ids.length === 0) {
      return res.json({
        success: true,
        kpis: { ca: 0, marge: 0, charges: 0, nb_ventes: 0, nb_commandes_attente: 0 },
        boutiques: [],
        commandes_attente: [],
        evolution: [],
        alertes_stock: [],
      });
    }

    const idsPlaceholders = ids.map(() => '?').join(',');
    const dVente = buildDateFilter(from, to, 'v.created_at');

    const [ventesStats, chargesStats, commandesAttente, evolution, alertesStock, parBoutique] =
      await Promise.all([
        get(
          `SELECT COALESCE(SUM(v.total_vente), 0) AS ca,
                  COALESCE(SUM(v.total_marge), 0) AS marge,
                  COUNT(DISTINCT v.id) AS nb_ventes
           FROM ventes v
           JOIN commandes cmd ON v.commande_id = cmd.id
           WHERE v.statut = 'validee' AND cmd.boutique_id IN (${idsPlaceholders}) ${dVente.sql}`,
          [...ids, ...dVente.params]
        ),
        get(
          `SELECT COALESCE(SUM(montant), 0) AS total
           FROM charges
           WHERE statut = 'validee' AND boutique_id IN (${idsPlaceholders})`,
          ids
        ),
        query(
          `SELECT c.*, u.fullname AS agent_name, b.name AS boutique_name
           FROM commandes c
           JOIN users u ON c.agent_id = u.id
           JOIN boutiques b ON c.boutique_id = b.id
           WHERE c.statut = 'en_attente' AND c.boutique_id IN (${idsPlaceholders})
           ORDER BY c.created_at ASC`,
          ids
        ),
        query(
          `SELECT strftime('%Y-%m-%d', v.created_at) AS period,
                  COALESCE(SUM(v.total_vente), 0) AS ca,
                  COALESCE(SUM(v.total_marge), 0) AS marge
           FROM ventes v
           JOIN commandes cmd ON v.commande_id = cmd.id
           WHERE v.statut = 'validee' AND cmd.boutique_id IN (${idsPlaceholders}) ${dVente.sql}
           GROUP BY period ORDER BY period ASC`,
          [...ids, ...dVente.params]
        ),
        query(
          `SELECT id, name, reference, stock, seuil_alerte, boutique_id
           FROM produits
           WHERE is_active = 1 AND stock <= seuil_alerte AND boutique_id IN (${idsPlaceholders})
           ORDER BY stock ASC LIMIT 20`,
          ids
        ),
        query(
          `SELECT b.id, b.name,
                  COALESCE(SUM(v.total_vente), 0) AS ca,
                  COALESCE(SUM(v.total_marge), 0) AS marge
           FROM boutiques b
           LEFT JOIN commandes cmd ON cmd.boutique_id = b.id AND cmd.statut IN ('validee','livree')
           LEFT JOIN ventes v ON v.commande_id = cmd.id AND v.statut = 'validee'
           WHERE b.id IN (${idsPlaceholders})
           GROUP BY b.id ORDER BY ca DESC`,
          ids
        ),
      ]);

    res.json({
      success: true,
      kpis: {
        ca: ventesStats.ca,
        marge: ventesStats.marge,
        charges: chargesStats.total,
        benefice: ventesStats.marge - chargesStats.total,
        nb_ventes: ventesStats.nb_ventes,
        nb_commandes_attente: commandesAttente.length,
      },
      boutiques: parBoutique,
      commandes_attente: commandesAttente,
      evolution,
      alertes_stock: alertesStock,
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/dashboards/agent
// Vue personnelle (ses ventes/marges)
// ─────────────────────────────────────────────
router.get(
  '/agent',
  validate([
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    if (!['admin', 'agent'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Accès réservé aux agents' });
    }

    const agentId = req.user.role === 'admin' && req.query.agent_id ? req.query.agent_id : req.user.userId;
    const { from, to } = req.query;
    const dVente = buildDateFilter(from, to, 'v.created_at');
    const dCmd = buildDateFilter(from, to, 'c.created_at');

    const [ventesStats, commandesEnAttente, topProduits, evolution, mesBoutiques] =
      await Promise.all([
        get(
          `SELECT COALESCE(SUM(v.total_vente), 0) AS ca,
                  COALESCE(SUM(v.total_marge), 0) AS marge,
                  COUNT(DISTINCT v.id) AS nb_ventes
           FROM ventes v
           WHERE v.agent_id = ? AND v.statut = 'validee' ${dVente.sql}`,
          [agentId, ...dVente.params]
        ),
        get(
          `SELECT COUNT(*) AS c FROM commandes c
           WHERE c.agent_id = ? AND c.statut = 'en_attente' ${dCmd.sql}`,
          [agentId, ...dCmd.params]
        ),
        query(
          `SELECT p.id, p.name, p.reference,
                  COALESCE(SUM(lc.quantite), 0) AS quantite,
                  COALESCE(SUM(lc.marge_calculee), 0) AS marge
           FROM lignes_commande lc
           JOIN produits p ON lc.produit_id = p.id
           JOIN commandes cmd ON lc.commande_id = cmd.id
           WHERE cmd.agent_id = ? AND cmd.statut IN ('validee','livree')
           GROUP BY p.id ORDER BY marge DESC LIMIT 5`,
          [agentId]
        ),
        query(
          `SELECT strftime('%Y-%m-%d', v.created_at) AS period,
                  COALESCE(SUM(v.total_vente), 0) AS ca,
                  COALESCE(SUM(v.total_marge), 0) AS marge
           FROM ventes v
           WHERE v.agent_id = ? AND v.statut = 'validee' ${dVente.sql}
           GROUP BY period ORDER BY period ASC`,
          [agentId, ...dVente.params]
        ),
        query(
          `SELECT DISTINCT b.id, b.name FROM boutiques b
           JOIN commandes c ON c.boutique_id = b.id
           WHERE c.agent_id = ?`,
          [agentId]
        ),
      ]);

    res.json({
      success: true,
      kpis: {
        ca: ventesStats.ca,
        marge: ventesStats.marge,
        nb_ventes: ventesStats.nb_ventes,
        commandes_attente: commandesEnAttente.c,
      },
      top_produits: topProduits,
      evolution,
      mes_boutiques: mesBoutiques,
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/dashboards/user
// Vue simple pour les users
// ─────────────────────────────────────────────
router.get(
  '/user',
  asyncHandler(async (req, res) => {
    const compteurs = await get(
      `SELECT
        (SELECT COUNT(*) FROM boutiques WHERE is_active = 1) AS nb_boutiques,
        (SELECT COUNT(*) FROM categories WHERE is_active = 1) AS nb_categories,
        (SELECT COUNT(*) FROM produits WHERE is_active = 1) AS nb_produits`
    );
    res.json({ success: true, compteurs });
  })
);

module.exports = router;