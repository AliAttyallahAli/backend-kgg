// backend/routes/commandes.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { get, run, query, transaction } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const {
  requirePermission,
  canAccessBoutique,
  getAccessibleBoutiques,
} = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');
const {
  calcCommandeMargin,
  validerCommandeEtCalculerMarge,
} = require('../services/marginCalculator');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// GET /api/commandes — liste paginée + filtres
// Scoping : agent → ses commandes ; gérant → son périmètre ; admin → tout
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    qv('statut').optional().isIn(['en_attente', 'validee', 'livree', 'annulee', 'all']),
    qv('agent_id').optional().isInt().toInt(),
    qv('boutique_id').optional().isInt().toInt(),
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
    qv('search').optional().trim().isLength({ max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = ['1=1'];
    const params = [];

    // Scoping
    if (req.user.role === 'agent') {
      conditions.push('c.agent_id = ?');
      params.push(req.user.userId);
    } else if (req.user.role === 'gerant') {
      const accessible = await getAccessibleBoutiques(req.user);
      const ids = accessible.map((b) => b.id);
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

    if (req.query.statut && req.query.statut !== 'all') {
      conditions.push('c.statut = ?');
      params.push(req.query.statut);
    }
    if (req.query.agent_id) {
      conditions.push('c.agent_id = ?');
      params.push(req.query.agent_id);
    }
    if (req.query.boutique_id) {
      conditions.push('c.boutique_id = ?');
      params.push(req.query.boutique_id);
    }
    if (req.query.from) {
      conditions.push('date(c.created_at) >= date(?)');
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push('date(c.created_at) <= date(?)');
      params.push(req.query.to);
    }
    if (req.query.search) {
      conditions.push('c.reference LIKE ?');
      params.push(`%${req.query.search}%`);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM commandes c WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT c.*,
              u.fullname AS agent_name,
              u.phone    AS agent_phone,
              b.name     AS boutique_name,
              vg.fullname AS valideur_name,
              (SELECT COUNT(*) FROM lignes_commande WHERE commande_id = c.id) AS nb_lignes,
              c.total_vente - c.total_partenaire AS marge
       FROM commandes c
       JOIN users u ON c.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON c.valide_par = vg.id
       WHERE ${where}
       ORDER BY c.created_at DESC
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
// GET /api/commandes/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const commande = await get(
      `SELECT c.*,
              u.fullname AS agent_name, u.phone AS agent_phone,
              b.name AS boutique_name,
              vg.fullname AS valideur_name
       FROM commandes c
       JOIN users u ON c.agent_id = u.id
       JOIN boutiques b ON c.boutique_id = b.id
       LEFT JOIN users vg ON c.valide_par = vg.id
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (!commande) throw new AppError('Commande introuvable', 404, 'COMMANDE_NOT_FOUND');

    // Scoping lecture
    if (req.user.role === 'agent' && commande.agent_id !== req.user.userId) {
      throw new AppError('Accès non autorisé', 403, 'COMMANDE_FORBIDDEN');
    }
    if (req.user.role === 'gerant') {
      const ok = await canAccessBoutique(req.user, commande.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'COMMANDE_FORBIDDEN');
    }

    const lignes = await query(
      `SELECT lc.*, p.name AS produit_name, p.reference AS produit_ref
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       WHERE lc.commande_id = ?`,
      [req.params.id]
    );

    res.json({
      success: true,
      commande: { ...commande, lignes },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/commandes — création par un agent
// RÈGLE MÉTIER : prend les prix actuellement dans `produits` (snapshot)
// Vérifie le stock disponible (mais ne décrémente pas — décrément à validation)
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('commandes', 'create'),
  validate([
    body('boutique_id').isInt().toInt().withMessage('Boutique requise'),
    body('lignes')
      .isArray({ min: 1 })
      .withMessage('Au moins une ligne de commande requise'),
    body('lignes.*.produit_id').isInt().toInt(),
    body('lignes.*.quantite').isInt({ min: 1 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const { boutique_id, lignes, notes } = req.body;

    // Seul un agent peut créer (ou admin pour le compte d'un agent)
    if (req.user.role !== 'agent' && req.user.role !== 'admin') {
      throw new AppError('Seuls les agents peuvent créer une commande', 403, 'ROLE_FORBIDDEN');
    }

    // Vérifier que l'agent a accès à cette boutique (ou admin)
    if (req.user.role === 'agent') {
      const ok = await canAccessBoutique(req.user, boutique_id);
      if (!ok) throw new AppError('Vous n\'avez pas accès à cette boutique', 403, 'BOUTIQUE_FORBIDDEN');
    }

    const boutique = await get('SELECT id FROM boutiques WHERE id = ? AND is_active = 1', [boutique_id]);
    if (!boutique) throw new AppError('Boutique introuvable ou inactive', 404, 'BOUTIQUE_NOT_FOUND');

    // Charger et valider les produits
    const produitsMap = new Map();
    for (const ligne of lignes) {
      const produit = await get(
        `SELECT * FROM produits WHERE id = ? AND boutique_id = ? AND is_active = 1`,
        [ligne.produit_id, boutique_id]
      );
      if (!produit) {
        throw new AppError(
          `Produit #${ligne.produit_id} introuvable ou hors de cette boutique`,
          404,
          'PRODUIT_NOT_FOUND'
        );
      }
      if (produit.stock < ligne.quantite) {
        throw new AppError(
          `Stock insuffisant pour "${produit.name}" : disponible ${produit.stock}, demandé ${ligne.quantite}`,
          400,
          'INSUFFICIENT_STOCK'
        );
      }
      produitsMap.set(ligne.produit_id, produit);
    }

    // Calculer les totaux côté serveur avec les prix actuels du produit
    const lignesCalc = lignes.map((l) => {
      const p = produitsMap.get(l.produit_id);
      return {
        quantite: l.quantite,
        prix_partenaire_applique: p.prix_partenaire,
        prix_vente_applique: p.prix_vente,
      };
    });
    const totals = calcCommandeMargin(lignesCalc);

    const reference = `CMD-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

    const result = await transaction(async (db) => {
      const cmdRes = await db.run(
        `INSERT INTO commandes
         (reference, agent_id, boutique_id, statut, total_partenaire, total_vente)
         VALUES (?, ?, ?, 'en_attente', ?, ?)`,
        [reference, req.user.userId, boutique_id, totals.total_partenaire, totals.total_vente]
      );

      const cmdId = cmdRes.lastID;

      for (const l of lignes) {
        const p = produitsMap.get(l.produit_id);
        await db.run(
          `INSERT INTO lignes_commande
           (commande_id, produit_id, quantite, prix_partenaire_applique, prix_vente_applique)
           VALUES (?, ?, ?, ?, ?)`,
          [cmdId, l.produit_id, l.quantite, p.prix_partenaire, p.prix_vente]
        );
      }

      return cmdId;
    });

    await logAction({
      userId: req.user.userId,
      action: 'COMMANDE_CREATED',
      resource: 'commandes',
      resourceId: result,
      details: { reference, boutique_id, nb_lignes: lignes.length, totals },
      ip: getClientIp(req),
    });

    // Notifier les gérants de la boutique
    const gerants = await query(
      `SELECT DISTINCT gerant_id FROM boutiques WHERE id = ? AND gerant_id IS NOT NULL
       UNION
       SELECT d.responsable_id FROM departements d
       JOIN boutiques b ON b.departement_id = d.id
       WHERE b.id = ? AND d.responsable_id IS NOT NULL`,
      [boutique_id, boutique_id]
    );
    for (const g of gerants) {
      if (g.gerant_id) {
        await run(
          `INSERT INTO notifications (user_id, title, message, type, category, link)
           VALUES (?, '🛒 Nouvelle commande', ?, 'info', 'commande', ?)`,
          [g.gerant_id, `Commande ${reference} en attente de validation`, `/commandes/${result}`]
        );
      }
    }

    const commande = await get('SELECT * FROM commandes WHERE id = ?', [result]);

    res.status(201).json({
      success: true,
      message: 'Commande créée (en attente de validation)',
      commande,
      marge_estimee: totals.total_marge,
    });
  })
);

// ─────────────────────────────────────────────
// PUT /api/commandes/:id/valider — validation gérant
// RÈGLE MÉTIER CRITIQUE :
//   - vérifie les stocks une 2e fois
//   - décrémente le stock
//   - crée une vente avec marge figée
// ─────────────────────────────────────────────
router.put(
  '/:id/valider',
  requirePermission('commandes', 'update'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const commande = await get('SELECT * FROM commandes WHERE id = ?', [targetId]);
    if (!commande) throw new AppError('Commande introuvable', 404, 'COMMANDE_NOT_FOUND');

    // Scoping
    if (req.user.role === 'gerant') {
      const ok = await canAccessBoutique(req.user, commande.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'COMMANDE_FORBIDDEN');
    }

    if (commande.statut !== 'en_attente') {
      throw new AppError(
        `Impossible : commande déjà "${commande.statut}"`,
        400,
        'INVALID_COMMANDE_STATUS'
      );
    }

    // Recharger les lignes pour re-vérifier les stocks au moment de la validation
    const lignes = await query(
      `SELECT lc.*, p.stock, p.name AS produit_name
       FROM lignes_commande lc
       JOIN produits p ON lc.produit_id = p.id
       WHERE lc.commande_id = ?`,
      [targetId]
    );

    if (lignes.length === 0) {
      throw new AppError('Commande sans lignes', 400, 'EMPTY_COMMANDE');
    }

    // Vérif stocks
    for (const l of lignes) {
      if (l.stock < l.quantite) {
        throw new AppError(
          `Stock insuffisant pour "${l.produit_name}" : disponible ${l.stock}, demandé ${l.quantite}`,
          400,
          'INSUFFICIENT_STOCK'
        );
      }
    }

    // Transaction atomique : décrément stock + créer vente + mise à jour commande
    let venteResult;
    try {
      venteResult = await transaction(async (db) => {
        // 1. Décrémenter les stocks
        for (const l of lignes) {
          await db.run(
            `UPDATE produits SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [l.quantite, l.produit_id]
          );
        }

        // 2. Créer la vente avec marge calculée (helper centralisé)
        const r = await validerCommandeEtCalculerMarge(targetId, req.user.userId);

        return r;
      });
    } catch (err) {
      throw err;
    }

    await logAction({
      userId: req.user.userId,
      action: 'COMMANDE_VALIDATED',
      resource: 'commandes',
      resourceId: targetId,
      details: venteResult,
      ip: getClientIp(req),
    });

    // Notifier l'agent
    await run(
      `INSERT INTO notifications (user_id, title, message, type, category, link)
       VALUES (?, '✅ Commande validée', ?, 'success', 'commande', ?)`,
      [
        commande.agent_id,
        `Commande validée. Marge générée : ${venteResult.total_marge.toLocaleString()} FCFA`,
        `/ventes/${venteResult.vente_id}`,
      ]
    );

    // Notifier admin
    const admin = await get(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1`);
    if (admin) {
      await run(
        `INSERT INTO notifications (user_id, title, message, type, category)
         VALUES (?, '📊 Vente validée', ?, 'info', 'vente')`,
        [
          admin.id,
          `Vente ${venteResult.vente_reference} — Marge : ${venteResult.total_marge.toLocaleString()} FCFA`,
        ]
      );
    }

    const updatedCommande = await get('SELECT * FROM commandes WHERE id = ?', [targetId]);

    res.json({
      success: true,
      message: 'Commande validée avec succès',
      commande: updatedCommande,
      vente: venteResult,
      marge_calculee: venteResult.total_marge,
    });
  })
);

// ─────────────────────────────────────────────
// PUT /api/commandes/:id/rejeter — rejet gérant
// ─────────────────────────────────────────────
router.put(
  '/:id/rejeter',
  requirePermission('commandes', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('motif').trim().isLength({ min: 3, max: 500 }).withMessage('Motif requis (3-500 car.)'),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { motif } = req.body;

    const commande = await get('SELECT * FROM commandes WHERE id = ?', [targetId]);
    if (!commande) throw new AppError('Commande introuvable', 404, 'COMMANDE_NOT_FOUND');

    if (req.user.role === 'gerant') {
      const ok = await canAccessBoutique(req.user, commande.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'COMMANDE_FORBIDDEN');
    }

    if (commande.statut !== 'en_attente') {
      throw new AppError(`Impossible : commande déjà "${commande.statut}"`, 400, 'INVALID_COMMANDE_STATUS');
    }

    await run(
      `UPDATE commandes SET
        statut = 'annulee',
        motif_annulation = ?,
        valide_par = ?,
        valide_at = datetime('now'),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [motif, req.user.userId, targetId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'COMMANDE_REJECTED',
      resource: 'commandes',
      resourceId: targetId,
      details: { motif },
      ip: getClientIp(req),
    });

    await run(
      `INSERT INTO notifications (user_id, title, message, type, category, link)
       VALUES (?, '❌ Commande rejetée', ?, 'warning', 'commande', ?)`,
      [commande.agent_id, `Motif : ${motif}`, `/commandes/${targetId}`]
    );

    const updated = await get('SELECT * FROM commandes WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Commande rejetée', commande: updated });
  })
);

// ─────────────────────────────────────────────
// PUT /api/commandes/:id/livrer — marquer livrée
// ─────────────────────────────────────────────
router.put(
  '/:id/livrer',
  requirePermission('commandes', 'update'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const commande = await get('SELECT * FROM commandes WHERE id = ?', [targetId]);
    if (!commande) throw new AppError('Commande introuvable', 404, 'COMMANDE_NOT_FOUND');

    if (req.user.role === 'gerant') {
      const ok = await canAccessBoutique(req.user, commande.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'COMMANDE_FORBIDDEN');
    }

    if (commande.statut !== 'validee') {
      throw new AppError(
        'Seules les commandes validées peuvent être livrées',
        400,
        'INVALID_COMMANDE_STATUS'
      );
    }

    await run(
      `UPDATE commandes SET statut = 'livree', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [targetId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'COMMANDE_DELIVERED',
      resource: 'commandes',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM commandes WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Commande livrée', commande: updated });
  })
);

module.exports = router;