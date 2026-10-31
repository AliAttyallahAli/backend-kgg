// backend/routes/ravitaillements.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query, transaction } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requirePermission, canAccessBoutique, getAccessibleBoutiques } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

const VALID_STATUTS = ['demande', 'en_cours', 'recu', 'annule'];

// ─────────────────────────────────────────────
// GET /api/ravitaillements
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    qv('boutique_id').optional().isInt().toInt(),
    qv('produit_id').optional().isInt().toInt(),
    qv('statut').optional().isIn([...VALID_STATUTS, 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    let allowedIds = null;
    if (req.user.role !== 'admin') {
      const acc = await getAccessibleBoutiques(req.user);
      allowedIds = acc.map((b) => b.id);
      if (allowedIds.length === 0) {
        return res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
    }

    const conditions = ['1=1'];
    const params = [];
    if (allowedIds) {
      conditions.push(`r.boutique_id IN (${allowedIds.map(() => '?').join(',')})`);
      params.push(...allowedIds);
    }
    if (req.query.boutique_id) { conditions.push('r.boutique_id = ?'); params.push(req.query.boutique_id); }
    if (req.query.produit_id) { conditions.push('r.produit_id = ?'); params.push(req.query.produit_id); }
    if (req.query.statut && req.query.statut !== 'all') { conditions.push('r.statut = ?'); params.push(req.query.statut); }

    const where = conditions.join(' AND ');

    const totalRow = await get(`SELECT COUNT(*) AS total FROM ravitaillements r WHERE ${where}`, params);

    const rows = await query(
      `SELECT r.*,
              b.name AS boutique_name,
              p.name AS produit_name, p.reference AS produit_ref, p.stock AS stock_actuel,
              u1.fullname AS lanceur_name,
              u2.fullname AS receptionnaire_name
       FROM ravitaillements r
       JOIN boutiques b ON r.boutique_id = b.id
       JOIN produits p ON r.produit_id = p.id
       LEFT JOIN users u1 ON r.lance_par = u1.id
       LEFT JOIN users u2 ON r.recu_par = u2.id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: totalRow.total, totalPages: Math.ceil(totalRow.total / limit) },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/ravitaillements
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('ravitaillements', 'create'),
  validate([
    body('boutique_id').isInt().toInt().withMessage('Boutique requise'),
    body('produit_id').isInt().toInt().withMessage('Produit requis'),
    body('quantite_demandee').isInt({ min: 1 }).toInt().withMessage('Quantité ≥ 1'),
    body('notes').optional().trim().isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const { boutique_id, produit_id, quantite_demandee, notes } = req.body;

    const boutique = await get('SELECT id FROM boutiques WHERE id = ? AND is_active = 1', [boutique_id]);
    if (!boutique) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');

    const ok = await canAccessBoutique(req.user, boutique_id);
    if (!ok) throw new AppError('Accès non autorisé', 403, 'BOUTIQUE_FORBIDDEN');

    const produit = await get('SELECT id, boutique_id, stock FROM produits WHERE id = ?', [produit_id]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');
    if (produit.boutique_id !== boutique_id) {
      throw new AppError('Le produit n\'appartient pas à cette boutique', 400, 'PRODUIT_BOUTIQUE_MISMATCH');
    }

    const result = await run(
      `INSERT INTO ravitaillements
       (boutique_id, produit_id, quantite_demandee, statut, lance_par, notes)
       VALUES (?, ?, ?, 'demande', ?, ?)`,
      [boutique_id, produit_id, quantite_demandee, req.user.userId, notes || null]
    );

    const ravitaillement = await get('SELECT * FROM ravitaillements WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'RAVITAILLEMENT_CREATED',
      resource: 'ravitaillements',
      resourceId: ravitaillement.id,
      details: { boutique_id, produit_id, quantite_demandee },
      ip: getClientIp(req),
    });

    // Notifier les admins
    const admins = await query(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1`);
    for (const a of admins) {
      await run(
        `INSERT INTO notifications (user_id, title, message, type, category, link)
         VALUES (?, '📦 Demande de ravitaillement', ?, 'info', 'stock', ?)`,
        [a.id, `Boutique #${boutique_id} — ${quantite_demandee} unités demandées`, `/ravitaillements/${ravitaillement.id}`]
      );
    }

    res.status(201).json({ success: true, message: 'Ravitaillement demandé', ravitaillement });
  })
);

// ─────────────────────────────────────────────
// PUT /api/ravitaillements/:id/recevoir
// Incrémente le stock du produit
// ─────────────────────────────────────────────
router.put(
  '/:id/recevoir',
  requirePermission('ravitaillements', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('quantite_recue').isInt({ min: 1 }).toInt().withMessage('Quantité reçue ≥ 1'),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { quantite_recue } = req.body;

    const r = await get('SELECT * FROM ravitaillements WHERE id = ?', [targetId]);
    if (!r) throw new AppError('Ravitaillement introuvable', 404, 'RAVITAILLEMENT_NOT_FOUND');

    const ok = await canAccessBoutique(req.user, r.boutique_id);
    if (!ok) throw new AppError('Accès non autorisé', 403, 'BOUTIQUE_FORBIDDEN');

    if (r.statut === 'recu') throw new AppError('Déjà reçu', 400, 'ALREADY_RECEIVED');
    if (r.statut === 'annule') throw new AppError('Ravitaillement annulé', 400, 'CANCELLED');

    if (quantite_recue > r.quantite_demandee) {
      throw new AppError(
        `Quantité reçue (${quantite_recue}) > demandée (${r.quantite_demandee})`,
        400,
        'QUANTITY_EXCEEDS_REQUEST'
      );
    }

    await transaction(async (db) => {
      // Incrémenter stock
      await db.run(
        `UPDATE produits SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [quantite_recue, r.produit_id]
      );
      // Mettre à jour ravitaillement
      await db.run(
        `UPDATE ravitaillements SET
          quantite_recue = ?, statut = 'recu', recu_par = ?, recu_at = datetime('now'),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [quantite_recue, req.user.userId, targetId]
      );
    });

    await logAction({
      userId: req.user.userId,
      action: 'RAVITAILLEMENT_RECEIVED',
      resource: 'ravitaillements',
      resourceId: targetId,
      details: { quantite_recue },
      ip: getClientIp(req),
    });

    if (r.lance_par) {
      await run(
        `INSERT INTO notifications (user_id, title, message, type, category)
         VALUES (?, '✅ Ravitaillement reçu', ?, 'success', 'stock')`,
        [r.lance_par, `${quantite_recue} unités reçues — stock mis à jour`]
      );
    }

    const updated = await get('SELECT * FROM ravitaillements WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Ravitaillement réceptionné', ravitaillement: updated });
  })
);

// ─────────────────────────────────────────────
// PUT /api/ravitaillements/:id/annuler
// ─────────────────────────────────────────────
router.put(
  '/:id/annuler',
  requirePermission('ravitaillements', 'update'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const r = await get('SELECT * FROM ravitaillements WHERE id = ?', [targetId]);
    if (!r) throw new AppError('Ravitaillement introuvable', 404, 'RAVITAILLEMENT_NOT_FOUND');
    if (r.statut === 'recu') throw new AppError('Déjà reçu', 400, 'ALREADY_RECEIVED');

    await run(
      `UPDATE ravitaillements SET statut = 'annule', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [targetId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'RAVITAILLEMENT_CANCELLED',
      resource: 'ravitaillements',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM ravitaillements WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Ravitaillement annulé', ravitaillement: updated });
  })
);

module.exports = router;