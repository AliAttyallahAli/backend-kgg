// backend/routes/paiements.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requirePermission, canAccessBoutique } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');
const { uploadPaiement } = require('../middlewares/upload');

router.use(authenticateToken);

const VALID_MOYENS = ['especes', 'mobile_money', 'virement', 'cheque', 'carte', 'alkherpay'];
const VALID_TYPES = ['salaire', 'prime', 'avance', 'autre'];

// ─────────────────────────────────────────────
// GET /api/paiements — liste paginée
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    qv('personnel_id').optional().isInt().toInt(),
    qv('type').optional().isIn([...VALID_TYPES, 'all']),
    qv('moyen_paiement').optional().isIn([...VALID_MOYENS, 'all']),
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
  ]),
  asyncHandler(async (req, res) => {
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = ['1=1'];
    const params = [];

    // Scoping via personnel → boutique
    if (req.user.role !== 'admin') {
      const { getAccessibleBoutiques } = require('../middlewares/rbac');
      const acc = await getAccessibleBoutiques(req.user);
      const ids = acc.map((b) => b.id);
      if (ids.length === 0) {
        return res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
      conditions.push(`(p.boutique_id IN (${ids.map(() => '?').join(',')}) OR p.boutique_id IS NULL)`);
      params.push(...ids);
    }

    if (req.query.personnel_id) { conditions.push('pa.personnel_id = ?'); params.push(req.query.personnel_id); }
    if (req.query.type && req.query.type !== 'all') { conditions.push('pa.type = ?'); params.push(req.query.type); }
    if (req.query.moyen_paiement && req.query.moyen_paiement !== 'all') {
      conditions.push('pa.moyen_paiement = ?'); params.push(req.query.moyen_paiement);
    }
    if (req.query.from) { conditions.push('date(pa.created_at) >= date(?)'); params.push(req.query.from); }
    if (req.query.to)   { conditions.push('date(pa.created_at) <= date(?)'); params.push(req.query.to); }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM paiements_personnel pa
       JOIN personnel p ON pa.personnel_id = p.id
       WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT pa.*,
              p.fullname AS personnel_name, p.poste,
              b.name AS boutique_name,
              u.fullname AS createur_name
       FROM paiements_personnel pa
       JOIN personnel p ON pa.personnel_id = p.id
       LEFT JOIN boutiques b ON p.boutique_id = b.id
       LEFT JOIN users u ON pa.created_by = u.id
       WHERE ${where}
       ORDER BY pa.created_at DESC
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
// GET /api/paiements/stats/summary
// ─────────────────────────────────────────────
router.get(
  '/stats/summary',
  validate([
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
    qv('personnel_id').optional().isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const conditions = ['1=1'];
    const params = [];

    if (req.query.personnel_id) { conditions.push('personnel_id = ?'); params.push(req.query.personnel_id); }
    if (req.query.from) { conditions.push('date(created_at) >= date(?)'); params.push(req.query.from); }
    if (req.query.to)   { conditions.push('date(created_at) <= date(?)'); params.push(req.query.to); }

    const where = conditions.join(' AND ');

    const global = await get(
      `SELECT
         COUNT(*) AS nb_paiements,
         COALESCE(SUM(montant), 0) AS total,
         COALESCE(SUM(CASE WHEN type='salaire' THEN montant ELSE 0 END), 0) AS salaires,
         COALESCE(SUM(CASE WHEN type='prime' THEN montant ELSE 0 END), 0) AS primes,
         COALESCE(SUM(CASE WHEN type='avance' THEN montant ELSE 0 END), 0) AS avances
       FROM paiements_personnel WHERE ${where}`,
      params
    );

    const parMoyen = await query(
      `SELECT moyen_paiement, COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total
       FROM paiements_personnel WHERE ${where}
       GROUP BY moyen_paiement`,
      params
    );

    res.json({ success: true, global, par_moyen: parMoyen });
  })
);

// ─────────────────────────────────────────────
// POST /api/paiements
// Justification + moyen de paiement + pièce jointe optionnelle
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('paiements', 'create'),
  uploadPaiement.single('piece_jointe'),
  validate([
    body('personnel_id').isInt().toInt().withMessage('Personnel requis'),
    body('montant').isInt({ min: 1 }).toInt().withMessage('Montant entier ≥ 1'),
    body('type').isIn(VALID_TYPES).withMessage('Type invalide'),
    body('moyen_paiement').isIn(VALID_MOYENS).withMessage('Moyen de paiement invalide'),
    body('justification').trim().isLength({ min: 3, max: 500 }).withMessage('Justification requise'),
    body('periode').optional().trim().isLength({ max: 20 }),
  ]),
  asyncHandler(async (req, res) => {
    const { personnel_id, montant, type, moyen_paiement, justification, periode } = req.body;
    const piece_jointe = req.file ? req.file.path.replace(/\\/g, '/') : null;

    const personnel = await get('SELECT * FROM personnel WHERE id = ?', [personnel_id]);
    if (!personnel) throw new AppError('Personnel introuvable', 404, 'PERSONNEL_NOT_FOUND');

    // Scoping
    if (req.user.role !== 'admin' && personnel.boutique_id) {
      const ok = await canAccessBoutique(req.user, personnel.boutique_id);
      if (!ok) throw new AppError('Accès non autorisé', 403, 'PAIEMENT_FORBIDDEN');
    }

    if (personnel.statut !== 'actif') {
      throw new AppError('Impossible de payer un personnel non actif', 400, 'PERSONNEL_NOT_ACTIVE');
    }

    const reference = `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    const result = await run(
      `INSERT INTO paiements_personnel
       (personnel_id, montant, type, moyen_paiement, justification, periode,
        reference_paie, piece_jointe, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personnel_id, montant, type, moyen_paiement, justification.trim(),
        periode || null, reference, piece_jointe, req.user.userId,
      ]
    );

    const paiement = await get('SELECT * FROM paiements_personnel WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'PAIEMENT_CREATED',
      resource: 'paiements_personnel',
      resourceId: paiement.id,
      details: { personnel_id, montant, type, moyen_paiement },
      ip: getClientIp(req),
    });

    // Notifier le personnel si lié à un user
    if (personnel.user_id) {
      await run(
        `INSERT INTO notifications (user_id, title, message, type, category)
         VALUES (?, '💰 Paiement reçu', ?, 'success', 'paiement')`,
        [
          personnel.user_id,
          `${type === 'salaire' ? 'Salaire' : type === 'prime' ? 'Prime' : 'Avance'} de ${montant.toLocaleString()} FCFA (${moyen_paiement})`,
        ]
      );
    }

    res.status(201).json({ success: true, message: 'Paiement enregistré', paiement });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/paiements/:id — admin uniquement
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('paiements', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const p = await get('SELECT * FROM paiements_personnel WHERE id = ?', [targetId]);
    if (!p) throw new AppError('Paiement introuvable', 404, 'PAIEMENT_NOT_FOUND');

    await run('DELETE FROM paiements_personnel WHERE id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'PAIEMENT_DELETED',
      resource: 'paiements_personnel',
      resourceId: targetId,
      details: { montant: p.montant, type: p.type },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Paiement supprimé' });
  })
);

module.exports = router;