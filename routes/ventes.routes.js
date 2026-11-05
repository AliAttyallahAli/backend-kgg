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

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════
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
// GET /api/ventes — liste avec partenaire + livreur
// ═══════════════════════════════════════════════
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 1000 }).toInt(),
    qv('agent_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('livreur_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('statut').optional({ values: 'falsy' }).isIn(['en_attente', 'validee', 'annulee', 'all']),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;

    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const agentId = cleanId(req.query.agent_id);
    const boutiqueId = cleanId(req.query.boutique_id);
    const categoryId = cleanId(req.query.category_id);
    const livreurId = cleanId(req.query.livreur_id);
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
    if (livreurId) { conditions.push('v.livreur_id = ?'); params.push(livreurId); }
    if (statut && statut !== 'all') { conditions.push('v.statut = ?'); params.push(statut); }
    if (from) { conditions.push('date(v.created_at) >= date(?)'); params.push(from); }
    if (to) { conditions.push('date(v.created_at) <= date(?)'); params.push(to); }
    if (search) {
      conditions.push('(v.reference LIKE ? OR c.reference LIKE ? OR u.fullname LIKE ? OR b.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
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
       JOIN users u ON v.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE ${where}`,
      params
    );

    // ✅ Requête avec partenaire + livreur
    const rows = await query(
      `SELECT 
        v.*,
        u.fullname AS agent_name,
        u.phone AS agent_phone,
        c.reference AS commande_ref,
        b.name AS boutique_name,
        vg.fullname AS valideur_name,
        CASE WHEN v.total_vente > 0
             THEN ROUND(v.total_marge * 100.0 / v.total_vente, 2)
             ELSE 0 END AS marge_pourcentage,
        (SELECT COUNT(*) FROM lignes_commande WHERE commande_id = v.commande_id) AS nb_lignes,
        
        -- ✅ LIVREUR (via livraisons)
        li.id AS livraison_id,
        li.reference AS livraison_ref,
        li.statut AS livraison_statut,
        li.adresse AS adresse_livraison,
        li.destinataire AS destinataire_livraison,
        li.telephone AS telephone_livraison,
        li.frais AS frais_livraison,
        li.created_at AS date_livraison,
        lv.id AS livreur_id,
        lv.fullname AS livreur_name,
        lv.phone AS livreur_phone,
        lv.vehicle AS livreur_vehicle,
        
        -- ✅ PARTENAIRE (via le 1er produit)
        (SELECT pt.name 
         FROM lignes_commande lc 
         JOIN produits p ON lc.produit_id = p.id 
         LEFT JOIN partenaires pt ON p.partenaire_id = pt.id 
         WHERE lc.commande_id = v.commande_id AND pt.name IS NOT NULL
         LIMIT 1) AS partenaire_name,
        (SELECT pt.phone 
         FROM lignes_commande lc 
         JOIN produits p ON lc.produit_id = p.id 
         LEFT JOIN partenaires pt ON p.partenaire_id = pt.id 
         WHERE lc.commande_id = v.commande_id AND pt.phone IS NOT NULL
         LIMIT 1) AS partenaire_phone,
        
        -- ✅ PRIX MOYEN + QUANTITÉ TOTALE
        (SELECT SUM(lc.quantite) FROM lignes_commande lc WHERE lc.commande_id = v.commande_id) AS quantite_totale,
        (SELECT ROUND(AVG(lc.prix_vente_applique)) FROM lignes_commande lc WHERE lc.commande_id = v.commande_id) AS prix_unitaire
        
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN users u ON v.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON v.valide_par = vg.id
       LEFT JOIN livraisons li ON li.commande_id = v.commande_id
       LEFT JOIN livreurs lv ON li.livreur_id = lv.id
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
    body('lignes').isArray({ min: 1 }).withMessage('Au moins une ligne requise'),
    body('lignes.*.produit_id').isInt().toInt(),
    body('lignes.*.quantite').isInt({ min: 1 }).toInt(),
    body('client_name').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    body('client_phone').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
    body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    // ✅ Livraison optionnelle
    body('livreur_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('adresse_livraison').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
    body('destinataire').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    body('telephone_destinataire').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
    body('frais_livraison').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('notes_livraison').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const {
      boutique_id, lignes, client_name, client_phone, notes,
      livreur_id, adresse_livraison, destinataire, telephone_destinataire,
      frais_livraison, notes_livraison,
    } = req.body;

    if (req.user.role !== 'admin') {
      const ok = await canAccessBoutique(req.user, boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'BOUTIQUE_FORBIDDEN');
    }

    // Validation : si livreur → adresse obligatoire
    if (livreur_id && !adresse_livraison) {
      throw new AppError('Adresse de livraison requise avec un livreur', 400, 'ADRESSE_REQUIRED');
    }

    const result = await executerVenteManuelle({
      lignes,
      boutiqueId: boutique_id,
      agentId: req.user.userId,
      valideParId: req.user.userId,
      clientName: client_name,
      clientPhone: client_phone,
      notes,
    });

    // ✅ Si livreur fourni → créer la livraison
    let livraison = null;
    if (livreur_id) {
      const livreur = await get('SELECT * FROM livreurs WHERE id = ? AND is_active = 1', [livreur_id]);
      if (!livreur) throw new AppError('Livreur introuvable ou inactif', 404, 'LIVREUR_NOT_FOUND');

      const livraisonRef = `LIV-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;
      const livRes = await run(
        `INSERT INTO livraisons
         (reference, commande_id, livreur_id, adresse, destinataire, telephone, notes, frais, statut, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en_cours', ?)`,
        [
          livraisonRef, result.commande_id, livreur_id, adresse_livraison,
          destinataire || null, telephone_destinataire || null,
          notes_livraison || null, frais_livraison || 0,
          req.user.userId,
        ]
      );

      // Mettre à jour la vente avec le livreur
      await run(
        `UPDATE ventes SET livreur_id = ?, adresse_livraison = ?, livreur_assigned_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [livreur_id, adresse_livraison, result.vente_id]
      );

      livraison = {
        id: livRes.lastID,
        reference: livraisonRef,
        livreur: { id: livreur.id, name: livreur.fullname, phone: livreur.phone },
        adresse: adresse_livraison,
      };
    }

    const vente = await get('SELECT * FROM ventes WHERE id = ?', [result.vente_id]);

    res.status(201).json({
      success: true,
      message: livraison
        ? `Vente enregistrée + livraison ${livraison.reference} assignée à ${livraison.livreur.name}`
        : `Vente enregistrée : ${result.vente_reference}`,
      vente,
      livraison,
      details: {
        total_vente: result.total_vente,
        total_partenaire: result.total_partenaire,
        total_marge: result.total_marge,
        marge_pourcentage: result.marge_pourcentage,
        nb_lignes: result.lignes.length,
        lignes: result.lignes,
      },
    });
  })
);

// ═══════════════════════════════════════════════
// GET /api/ventes/detaillees — tableau détaillé par produit
// ⚠️ AVANT /:id
// ═══════════════════════════════════════════════
router.get(
  '/detaillees',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 }).toInt(),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;

    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const search = (req.query.search || '').trim();
    const boutiqueId = cleanId(req.query.boutique_id);

    const conditions = ["v.statut = 'validee'"];
    const params = [];

    if (req.user.role === 'agent') {
      conditions.push('v.agent_id = ?');
      params.push(req.user.userId);
    } else if (req.user.role === 'gerant') {
      const acc = await getAccessibleBoutiques(req.user);
      const ids = acc.map((b) => b.id);
      if (ids.length === 0) {
        return res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
      conditions.push(`c.boutique_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    if (from) { conditions.push('date(v.created_at) >= date(?)'); params.push(from); }
    if (to) { conditions.push('date(v.created_at) <= date(?)'); params.push(to); }
    if (search) {
      conditions.push('(v.reference LIKE ? OR p.name LIKE ? OR u.fullname LIKE ? OR c.reference LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (boutiqueId) { conditions.push('c.boutique_id = ?'); params.push(boutiqueId); }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total 
       FROM ventes v
       JOIN users u ON v.agent_id = u.id
       JOIN commandes c ON v.commande_id = c.id
       JOIN lignes_commande lc ON lc.commande_id = c.id
       JOIN produits p ON lc.produit_id = p.id
       WHERE ${where}`,
      params
    );

    // ✅ Détail par ligne avec partenaire + livreur
    const rows = await query(
      `SELECT 
        v.id AS vente_id,
        v.reference AS vente_ref,
        v.created_at,
        v.total_vente AS total_vente,
        v.total_marge AS total_marge_vente,
        
        u.fullname AS agent_name,
        
        p.name AS produit_name,
        p.reference AS produit_ref,
        lc.quantite,
        lc.prix_vente_applique AS prix_unitaire,
        lc.prix_partenaire_applique AS prix_partenaire,
        (lc.prix_vente_applique - lc.prix_partenaire_applique) AS marge_unitaire,
        (lc.prix_vente_applique * lc.quantite) AS sous_total,
        (lc.marge_calculee) AS marge_ligne,
        
        c.reference AS commande_ref,
        b.name AS boutique_name,
        
        -- ✅ PARTENAIRE du produit
        pt.id AS partenaire_id,
        pt.name AS partenaire_name,
        pt.phone AS partenaire_phone,
        
        -- ✅ LIVREUR de la vente
        li.id AS livraison_id,
        li.reference AS livraison_ref,
        li.statut AS livraison_statut,
        li.adresse AS adresse_livraison,
        li.destinataire AS destinataire_livraison,
        lv.id AS livreur_id,
        lv.fullname AS livreur_name,
        lv.phone AS livreur_phone,
        lv.vehicle AS livreur_vehicle
        
       FROM ventes v
       JOIN users u ON v.agent_id = u.id
       JOIN commandes c ON v.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       JOIN lignes_commande lc ON lc.commande_id = c.id
       JOIN produits p ON lc.produit_id = p.id
       LEFT JOIN partenaires pt ON p.partenaire_id = pt.id
       LEFT JOIN livraisons li ON li.commande_id = v.commande_id
       LEFT JOIN livreurs lv ON li.livreur_id = lv.id
       WHERE ${where}
       ORDER BY v.created_at DESC, lc.id ASC
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
              vg.fullname AS valideur_name,
              -- ✅ Livreur
              li.id AS livraison_id,
              li.reference AS livraison_ref,
              li.statut AS livraison_statut,
              li.adresse AS adresse_livraison,
              li.destinataire AS destinataire_livraison,
              li.telephone AS telephone_livraison,
              li.frais AS frais_livraison,
              li.livree_at AS date_livraison,
              lv.id AS livreur_id,
              lv.fullname AS livreur_name,
              lv.phone AS livreur_phone,
              lv.vehicle AS livreur_vehicle,
              lv.zone AS livreur_zone
       FROM ventes v
       JOIN commandes c ON v.commande_id = c.id
       JOIN users u ON v.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON v.valide_par = vg.id
       LEFT JOIN livraisons li ON li.commande_id = v.commande_id
       LEFT JOIN livreurs lv ON li.livreur_id = lv.id
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

    // ✅ Lignes avec partenaire
    const lignes = await query(
      `SELECT lc.*,
              p.name AS produit_name,
              p.reference AS produit_ref,
              (lc.prix_vente_applique - lc.prix_partenaire_applique) AS marge_unitaire,
              (lc.prix_vente_applique * lc.quantite) AS sous_total,
              pt.id AS partenaire_id,
              pt.name AS partenaire_name,
              pt.phone AS partenaire_phone
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       LEFT JOIN partenaires pt ON p.partenaire_id = pt.id
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