// backend/routes/ventes.routes.js
const express = require('express');
const { param, query: qv, body } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { get, query, run, transaction } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const {
  requirePermission,
  getAccessibleBoutiques,
  canAccessBoutique,
} = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const {
  getMarginStats,
  getMarginEvolution,
  getProductRanking,
  calcCommandeMargin,
  executerVenteManuelle,
} = require('../services/marginCalculator');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function cleanDate(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'all') return undefined;
  return s;
}

function cleanId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

// ═══════════════════════════════════════════════
// GET /api/ventes — liste paginée + filtres
// ═══════════════════════════════════════════════
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 1000 }).toInt(),
    qv('agent_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('statut').optional({ values: 'falsy' }).isIn(['en_attente', 'validee', 'annulee', 'all']),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const agentId = cleanId(req.query.agent_id);
    const boutiqueId = cleanId(req.query.boutique_id);
    const categoryId = cleanId(req.query.category_id);
    const statut = req.query.statut;
    const search = (req.query.search || '').trim();

    const conditions = ['1=1'];
    const params = [];

    // Scoping
    if (req.user.role === 'agent') {
      conditions.push('v.agent_id = ?');
      params.push(req.user.userId);
    } else if (req.user.role === 'gerant') {
      const acc = await getAccessibleBoutiques(req.user);
      const ids = acc.map((b) => b.id);
      if (ids.length === 0) {
        return res.json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
        });
      }
      conditions.push(`c.boutique_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    if (agentId) { conditions.push('v.agent_id = ?'); params.push(agentId); }
    if (boutiqueId) { conditions.push('c.boutique_id = ?'); params.push(boutiqueId); }
    if (statut && statut !== 'all') { conditions.push('v.statut = ?'); params.push(statut); }
    if (from) { conditions.push('date(v.created_at) >= date(?)'); params.push(from); }
    if (to)   { conditions.push('date(v.created_at) <= date(?)'); params.push(to); }
    if (search) {
      conditions.push('(v.reference LIKE ? OR c.reference LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
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
       WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT v.*,
              u.fullname AS agent_name, u.phone AS agent_phone,
              c.reference AS commande_ref,
              b.name AS boutique_name,
              vg.fullname AS valideur_name,
              CASE WHEN v.total_vente > 0
                   THEN ROUND(v.total_marge * 100.0 / v.total_vente, 2)
                   ELSE 0 END AS marge_pourcentage,
              (SELECT COUNT(*) FROM lignes_commande WHERE commande_id = v.commande_id) AS nb_lignes
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN users u ON v.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON v.valide_par = vg.id
       WHERE ${where}
       ORDER BY v.created_at DESC
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
// GET /api/ventes/stats/global
// ⚠️ AVANT /:id
// ═══════════════════════════════════════════════
router.get(
  '/stats/global',
  validate([
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('agent_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('granularity').optional({ values: 'falsy' }).isIn(['day', 'month']),
  ]),
  asyncHandler(async (req, res) => {
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    let boutiqueId = cleanId(req.query.boutique_id);
    let agentId = cleanId(req.query.agent_id);
    const categoryId = cleanId(req.query.category_id);
    const granularity = req.query.granularity || 'day';

    if (req.user.role === 'agent') agentId = req.user.userId;
    if (req.user.role === 'gerant' && !boutiqueId) {
      const acc = await getAccessibleBoutiques(req.user);
      if (acc.length === 1) boutiqueId = acc[0].id;
    }

    const stats = await getMarginStats({ from, to, boutiqueId, agentId, categoryId });
    const evolution = await getMarginEvolution({ from, to, boutiqueId, agentId, granularity });

    res.json({ success: true, stats, evolution });
  })
);

// ═══════════════════════════════════════════════
// GET /api/ventes/stats/products
// ⚠️ AVANT /:id
// ═══════════════════════════════════════════════
router.get(
  '/stats/products',
  validate([
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const boutiqueId = cleanId(req.query.boutique_id);
    const limit = parseInt(req.query.limit, 10) || 10;

    const ranking = await getProductRanking({ from, to, boutiqueId, limit });
    res.json({ success: true, ranking });
  })
);

// ═══════════════════════════════════════════════
// POST /api/ventes/manuel — vente manuelle
// ⚠️ AVANT /:id
// ═══════════════════════════════════════════════
router.post(
  '/manuel',
  requirePermission('ventes', 'create'),
  validate([
    body('boutique_id').isInt().toInt().withMessage('Boutique requise'),
    body('lignes')
      .isArray({ min: 1 })
      .withMessage('Au moins une ligne requise'),
    body('lignes.*.produit_id').isInt().toInt().withMessage('Produit requis par ligne'),
    body('lignes.*.quantite').isInt({ min: 1 }).toInt().withMessage('Quantité ≥ 1 par ligne'),
    body('client_name').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    body('client_phone').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
    body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const { boutique_id, lignes, client_name, client_phone, notes } = req.body;

    // Scoping : un gérant/agent ne peut vendre que dans son périmètre
    if (req.user.role !== 'admin') {
      const ok = await canAccessBoutique(req.user, boutique_id);
      if (!ok) {
        throw new AppError('Accès non autorisé à cette boutique', 403, 'BOUTIQUE_FORBIDDEN');
      }
    }

    // ✅ Exécution centralisée (calcul + transaction)
    const result = await executerVenteManuelle({
      lignes,
      boutiqueId: boutique_id,
      agentId: req.user.userId,
      valideParId: req.user.userId,
      clientName: client_name,
      clientPhone: client_phone,
      notes,
    });

    // Audit log
    try {
      await logAction({
        userId: req.user.userId,
        action: 'VENTE_MANUELLE_CREATED',
        resource: 'ventes',
        resourceId: result.vente_id,
        details: {
          boutique_id,
          nb_lignes: lignes.length,
          total_vente: result.total_vente,
          total_marge: result.total_marge,
          client_name: client_name || null,
        },
        ip: getClientIp(req),
      });
    } catch (logErr) {
      console.warn('⚠️ Audit log échoué:', logErr.message);
    }

    // Notifications aux admins
    try {
      const admins = await query(
        `SELECT id FROM users WHERE role = 'admin' AND is_active = 1`
      );
      for (const a of admins) {
        await run(
          `INSERT INTO notifications (user_id, title, message, type, category, link)
           VALUES (?, '💰 Vente manuelle enregistrée', ?, 'success', 'vente', ?)`,
          [
            a.id,
            `${req.user.fullname || 'Agent'} a enregistré une vente de ${result.total_vente.toLocaleString()} FCFA (${result.boutique.name})`,
            `/ventes/${result.vente_id}`,
          ]
        );
      }
    } catch (notifErr) {
      console.warn('⚠️ Notifications non envoyées:', notifErr.message);
    }

    // Récupérer la vente
    const vente = await get('SELECT * FROM ventes WHERE id = ?', [result.vente_id]);

    // ✅ Construire la réponse avec prix unitaires détaillés
    res.status(201).json({
      success: true,
      message: `Vente enregistrée : ${result.vente_reference} — Marge : ${result.total_marge.toLocaleString()} FCFA`,
      vente,
      details: {
        // Totaux globaux
        total_vente: result.total_vente,
        total_partenaire: result.total_partenaire,
        total_marge: result.total_marge,
        marge_pourcentage: result.marge_pourcentage,
        nb_lignes: result.lignes.length,

        // Client / métadonnées
        client_name: result.client_name,
        client_phone: result.client_phone,
        notes: result.notes,
        boutique: {
          id: result.boutique.id,
          name: result.boutique.name,
        },

        // ✅ Détail par ligne avec prix unitaires
        lignes: result.lignes.map((l) => ({
          produit_id: l.produit_id,
          produit_name: l.produit_name,
          produit_ref: l.produit_ref,
          quantite: l.quantite,

          // Prix unitaires
          prix_partenaire_unitaire: l.prix_partenaire_applique,
          prix_vente_unitaire: l.prix_vente_applique,
          marge_unitaire: l.prix_vente_applique - l.prix_partenaire_applique,

          // Sous-totaux par ligne
          sous_total_vente: l.prix_vente_applique * l.quantite,
          sous_total_partenaire: l.prix_partenaire_applique * l.quantite,
          sous_total_marge: (l.prix_vente_applique - l.prix_partenaire_applique) * l.quantite,
        })),
      },
    });
  })
);

// ═══════════════════════════════════════════════
// GET /api/ventes/:id — détail d'une vente
// ⚠️ APRÈS toutes les routes statiques
// ═══════════════════════════════════════════════
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const vente = await get(
      `SELECT v.*,
              u.fullname AS agent_name, u.phone AS agent_phone,
              c.reference AS commande_ref, c.boutique_id,
              b.name AS boutique_name,
              vg.fullname AS valideur_name
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN users u ON v.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON v.valide_par = vg.id
       WHERE v.id = ?`,
      [req.params.id]
    );
    if (!vente) throw new AppError('Vente introuvable', 404, 'VENTE_NOT_FOUND');

    // Scoping
    if (req.user.role === 'agent' && vente.agent_id !== req.user.userId) {
      throw new AppError('Accès non autorisé', 403, 'VENTE_FORBIDDEN');
    }
    if (req.user.role === 'gerant') {
      const ok = await canAccessBoutique(req.user, vente.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'VENTE_FORBIDDEN');
    }

    // ✅ Charger les lignes avec prix unitaires
    const lignes = await query(
      `SELECT lc.*,
              p.name AS produit_name,
              p.reference AS produit_ref,
              (lc.prix_vente_applique - lc.prix_partenaire_applique) AS marge_unitaire,
              (lc.prix_vente_applique * lc.quantite) AS sous_total_vente,
              (lc.prix_partenaire_applique * lc.quantite) AS sous_total_partenaire
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
        lignes: lignes.map((l) => ({
          id: l.id,
          produit_id: l.produit_id,
          produit_name: l.produit_name,
          produit_ref: l.produit_ref,
          quantite: l.quantite,

          // ✅ Prix unitaires
          prix_partenaire_unitaire: l.prix_partenaire_applique,
          prix_vente_unitaire: l.prix_vente_applique,
          marge_unitaire: l.marge_unitaire,

          // ✅ Sous-totaux
          sous_total_vente: l.sous_total_vente,
          sous_total_partenaire: l.sous_total_partenaire,
          sous_total_marge: l.marge_unitaire * l.quantite,
        })),
      },
    });
  })
);

module.exports = router;