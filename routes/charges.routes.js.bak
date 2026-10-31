// backend/routes/charges.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requirePermission, canAccessBoutique, getAccessibleBoutiques } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');
const { uploadCharge } = require('../middlewares/upload');

router.use(authenticateToken);

const VALID_MOYENS = ['especes', 'mobile_money', 'virement', 'cheque', 'carte', 'alkherpay'];
const VALID_STATUTS = ['en_attente', 'validee', 'rejetee'];
const VALID_TYPES = [
  'loyer', 'transport', 'electricite', 'eau', 'internet', 'telephone',
  'fournitures', 'maintenance', 'salaires', 'marketing', 'taxes', 'divers',
];

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

// ─────────────────────────────────────────────
// GET /api/charges — liste paginée + filtres
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 1000 }).toInt(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('type').optional({ values: 'falsy' }).isIn([...VALID_TYPES, 'all']),
    qv('moyen_paiement').optional({ values: 'falsy' }).isIn([...VALID_MOYENS, 'all']),
    qv('statut').optional({ values: 'falsy' }).isIn([...VALID_STATUTS, 'all']),
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
    const boutiqueId = cleanId(req.query.boutique_id);
    const type = req.query.type;
    const moyen = req.query.moyen_paiement;
    const statut = req.query.statut;
    const search = cleanStr(req.query.search);

    // Scoping
    let allowedBoutiqueIds = null;
    if (req.user.role !== 'admin') {
      const acc = await getAccessibleBoutiques(req.user);
      allowedBoutiqueIds = acc.map((b) => b.id);
      if (allowedBoutiqueIds.length === 0) {
        return res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
    }

    const conditions = ['1=1'];
    const params = [];

    if (allowedBoutiqueIds) {
      conditions.push(`(ch.boutique_id IN (${allowedBoutiqueIds.map(() => '?').join(',')}) OR ch.boutique_id IS NULL)`);
      params.push(...allowedBoutiqueIds);
    }
    if (boutiqueId) { conditions.push('ch.boutique_id = ?'); params.push(boutiqueId); }
    if (type && type !== 'all') { conditions.push('ch.type = ?'); params.push(type); }
    if (moyen && moyen !== 'all') { conditions.push('ch.moyen_paiement = ?'); params.push(moyen); }
    if (statut && statut !== 'all') { conditions.push('ch.statut = ?'); params.push(statut); }
    if (from) { conditions.push('date(ch.date_charge) >= date(?)'); params.push(from); }
    if (to)   { conditions.push('date(ch.date_charge) <= date(?)'); params.push(to); }
    if (search) {
      conditions.push('(ch.justification LIKE ? OR ch.type LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(`SELECT COUNT(*) AS total FROM charges ch WHERE ${where}`, params);
    const totalMontant = await get(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM charges ch WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT ch.*,
              b.name AS boutique_name,
              u.fullname AS createur_name,
              vg.fullname AS valideur_name
       FROM charges ch
       LEFT JOIN boutiques b ON ch.boutique_id = b.id
       LEFT JOIN users u ON ch.created_by = u.id
       LEFT JOIN users vg ON ch.valide_par = vg.id
       WHERE ${where}
       ORDER BY ch.date_charge DESC, ch.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      total_montant: totalMontant.total,
      pagination: { page, limit, total: totalRow.total, totalPages: Math.ceil(totalRow.total / limit) },
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/charges/stats/summary
// ⚠️ AVANT /:id
// ─────────────────────────────────────────────
router.get(
  '/stats/summary',
  validate([
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const boutiqueId = cleanId(req.query.boutique_id);

    const conditions = ["statut = 'validee'"];
    const params = [];

    if (boutiqueId) { conditions.push('boutique_id = ?'); params.push(boutiqueId); }
    if (from) { conditions.push('date(date_charge) >= date(?)'); params.push(from); }
    if (to)   { conditions.push('date(date_charge) <= date(?)'); params.push(to); }

    const where = conditions.join(' AND ');

    const global = await get(
      `SELECT COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total FROM charges WHERE ${where}`,
      params
    );

    const parType = await query(
      `SELECT type, COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total
       FROM charges WHERE ${where}
       GROUP BY type ORDER BY total DESC`,
      params
    );

    const parMoyen = await query(
      `SELECT moyen_paiement, COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total
       FROM charges WHERE ${where}
       GROUP BY moyen_paiement`,
      params
    );

    const evolution = await query(
      `SELECT strftime('%Y-%m', date_charge) AS period,
              COALESCE(SUM(montant), 0) AS total
       FROM charges WHERE ${where}
       GROUP BY period ORDER BY period ASC`,
      params
    );

    res.json({ success: true, global, par_type: parType, par_moyen: parMoyen, evolution });
  })
);

// ─────────────────────────────────────────────
// GET /api/charges/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const ch = await get(
      `SELECT ch.*,
              b.name AS boutique_name,
              u.fullname AS createur_name,
              vg.fullname AS valideur_name
       FROM charges ch
       LEFT JOIN boutiques b ON ch.boutique_id = b.id
       LEFT JOIN users u ON ch.created_by = u.id
       LEFT JOIN users vg ON ch.valide_par = vg.id
       WHERE ch.id = ?`,
      [req.params.id]
    );
    if (!ch) throw new AppError('Charge introuvable', 404, 'CHARGE_NOT_FOUND');

    // Scoping
    if (req.user.role !== 'admin' && ch.boutique_id) {
      const ok = await canAccessBoutique(req.user, ch.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'CHARGE_FORBIDDEN');
    }

    res.json({ success: true, charge: ch });
  })
);

// ─────────────────────────────────────────────
// POST /api/charges — création
// RÈGLE : justification + moyen_paiement OBLIGATOIRES
// Boutique OPTIONNELLE (charge générale autorisée pour tous)
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('charges', 'create'),
  uploadCharge.single('piece_jointe'),
  validate([
    body('type').isIn(VALID_TYPES).withMessage('Type de charge invalide'),
    body('montant').isInt({ min: 1 }).toInt().withMessage('Montant entier ≥ 1'),
    body('justification').trim().isLength({ min: 5, max: 500 }).withMessage('Justification obligatoire (5-500 car.)'),
    body('moyen_paiement').isIn(VALID_MOYENS).withMessage('Moyen de paiement invalide'),
    body('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('date_charge').optional({ values: 'falsy' }).isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    const { type, montant, justification, moyen_paiement, date_charge } = req.body;
    const boutique_id = cleanId(req.body.boutique_id);
    const piece_jointe = req.file ? req.file.path.replace(/\\/g, '/') : null;

    // ✅ Scoping : si une boutique est fournie, vérifier l'accès
    if (boutique_id) {
      const b = await get('SELECT id FROM boutiques WHERE id = ? AND is_active = 1', [boutique_id]);
      if (!b) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');
      const ok = await canAccessBoutique(req.user, boutique_id);
      if (!ok) throw new AppError('Accès non autorisé à cette boutique', 403, 'BOUTIQUE_FORBIDDEN');
    }
    // ⚠️ Charge sans boutique = charge générale du groupe (autorisé pour tous)

    // Statut : un gérant crée en "en_attente", un admin valide directement
    const statut = req.user.role === 'admin' ? 'validee' : 'en_attente';
    const valide_par = req.user.role === 'admin' ? req.user.userId : null;

    const result = await run(
      `INSERT INTO charges
       (boutique_id, type, montant, justification, moyen_paiement,
        piece_jointe, statut, date_charge, created_by, valide_par, valide_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        boutique_id || null, type, montant, justification.trim(), moyen_paiement,
        piece_jointe, statut,
        date_charge || new Date().toISOString().slice(0, 10),
        req.user.userId, valide_par,
        statut === 'validee' ? new Date().toISOString() : null,
      ]
    );

    const charge = await get('SELECT * FROM charges WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'CHARGE_CREATED',
      resource: 'charges',
      resourceId: charge.id,
      details: { type, montant, moyen_paiement, statut, boutique_id: boutique_id || null },
      ip: getClientIp(req),
    });

    // Notifier les admins si en attente
    if (statut === 'en_attente') {
      const admins = await query(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1`);
      for (const a of admins) {
        await run(
          `INSERT INTO notifications (user_id, title, message, type, category, link)
           VALUES (?, '💸 Charge à valider', ?, 'info', 'charge', ?)`,
          [a.id, `${type} — ${montant.toLocaleString()} FCFA : ${justification.slice(0, 80)}`, `/charges/${charge.id}`]
        );
      }
    }

    res.status(201).json({
      success: true,
      message:
        statut === 'validee'
          ? 'Charge enregistrée et validée'
          : 'Charge enregistrée — en attente de validation admin',
      charge,
    });
  })
);

// ─────────────────────────────────────────────
// PUT /api/charges/:id/valider — admin uniquement
// ─────────────────────────────────────────────
router.put(
  '/:id/valider',
  requirePermission('charges', 'update'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const ch = await get('SELECT * FROM charges WHERE id = ?', [targetId]);
    if (!ch) throw new AppError('Charge introuvable', 404, 'CHARGE_NOT_FOUND');

    if (req.user.role !== 'admin') {
      throw new AppError('Seul un admin peut valider une charge', 403, 'ADMIN_ONLY');
    }
    if (ch.statut !== 'en_attente') {
      throw new AppError(`Charge déjà "${ch.statut}"`, 400, 'INVALID_CHARGE_STATUS');
    }

    await run(
      `UPDATE charges SET statut = 'validee', valide_par = ?, valide_at = datetime('now') WHERE id = ?`,
      [req.user.userId, targetId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'CHARGE_VALIDATED',
      resource: 'charges',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    // Notifier le créateur
    if (ch.created_by) {
      await run(
        `INSERT INTO notifications (user_id, title, message, type, category)
         VALUES (?, '✅ Charge validée', ?, 'success', 'charge')`,
        [ch.created_by, `Charge ${ch.type} (${ch.montant.toLocaleString()} FCFA) validée`]
      );
    }

    const updated = await get('SELECT * FROM charges WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Charge validée', charge: updated });
  })
);

// ─────────────────────────────────────────────
// PUT /api/charges/:id/rejeter — admin uniquement
// ─────────────────────────────────────────────
router.put(
  '/:id/rejeter',
  requirePermission('charges', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('motif').trim().isLength({ min: 3, max: 500 }).withMessage('Motif requis'),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { motif } = req.body;
    const ch = await get('SELECT * FROM charges WHERE id = ?', [targetId]);
    if (!ch) throw new AppError('Charge introuvable', 404, 'CHARGE_NOT_FOUND');

    if (req.user.role !== 'admin') {
      throw new AppError('Seul un admin peut rejeter une charge', 403, 'ADMIN_ONLY');
    }

    await run(
      `UPDATE charges SET statut = 'rejetee', valide_par = ?, valide_at = datetime('now') WHERE id = ?`,
      [req.user.userId, targetId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'CHARGE_REJECTED',
      resource: 'charges',
      resourceId: targetId,
      details: { motif },
      ip: getClientIp(req),
    });

    if (ch.created_by) {
      await run(
        `INSERT INTO notifications (user_id, title, message, type, category)
         VALUES (?, '❌ Charge rejetée', ?, 'warning', 'charge')`,
        [ch.created_by, `Motif : ${motif}`]
      );
    }

    const updated = await get('SELECT * FROM charges WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Charge rejetée', charge: updated });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/charges/:id — admin uniquement
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('charges', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const ch = await get('SELECT * FROM charges WHERE id = ?', [targetId]);
    if (!ch) throw new AppError('Charge introuvable', 404, 'CHARGE_NOT_FOUND');

    await run('DELETE FROM charges WHERE id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'CHARGE_DELETED',
      resource: 'charges',
      resourceId: targetId,
      details: { type: ch.type, montant: ch.montant },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Charge supprimée' });
  })
);

module.exports = router;