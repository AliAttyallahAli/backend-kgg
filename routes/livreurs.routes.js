// backend/routes/livreurs.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

const VEHICLES = ['moto', 'voiture', 'velo', 'camion', 'pied'];

// ═══════════════════════════════════════════════
// GET /api/livreurs — liste (admin + gérant)
// ═══════════════════════════════════════════════
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 200 }).toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('is_active').optional({ values: 'falsy' }).isIn(['0', '1', 'all']),
    qv('sort').optional({ values: 'falsy' }).isIn(['name', 'livraisons', 'recent']),
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

    const conditions = ['1=1'];
    const params = [];

    if (search) {
      conditions.push('(l.fullname LIKE ? OR l.phone LIKE ? OR l.email LIKE ? OR l.zone LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (isActive && isActive !== 'all') {
      conditions.push('l.is_active = ?');
      params.push(parseInt(isActive, 10));
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM livreurs l WHERE ${where}`,
      params
    );

    let orderBy = 'l.fullname ASC';
    if (sort === 'name') orderBy = `l.fullname ${order}`;
    else if (sort === 'recent') orderBy = `l.created_at ${order}`;
    else if (sort === 'livraisons') orderBy = 'total_livraisons DESC';

    const rows = await query(
      `SELECT
        l.id, l.fullname, l.phone, l.email, l.address, l.vehicle, l.vehicle_plate,
        l.zone, l.is_active, l.created_at,
        COALESCE((SELECT COUNT(*) FROM livraisons WHERE livreur_id = l.id), 0) AS total_livraisons,
        COALESCE((SELECT COUNT(*) FROM livraisons WHERE livreur_id = l.id AND statut = 'livree'), 0) AS livrees,
        COALESCE((SELECT COUNT(*) FROM livraisons WHERE livreur_id = l.id AND statut = 'en_cours'), 0) AS en_cours
       FROM livreurs l
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
// GET /api/livreurs/actifs — liste pour dropdown
// ⚠️ DOIT ÊTRE AVANT /:id
// ═══════════════════════════════════════════════
router.get(
  '/actifs',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, fullname, phone, vehicle, zone
       FROM livreurs WHERE is_active = 1
       ORDER BY fullname ASC`
    );
    res.json({ success: true, data: rows });
  })
);

// ═══════════════════════════════════════════════
// GET /api/livreurs/:id — détail
// ⚠️ DOIT ÊTRE APRÈS /actifs
// ═══════════════════════════════════════════════
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const livreur = await get('SELECT * FROM livreurs WHERE id = ?', [req.params.id]);
    if (!livreur) throw new AppError('Livreur introuvable', 404, 'LIVREUR_NOT_FOUND');

    const stats = await get(
      `SELECT
        COUNT(*) AS total_livraisons,
        SUM(CASE WHEN statut = 'livree' THEN 1 ELSE 0 END) AS livrees,
        SUM(CASE WHEN statut = 'en_cours' THEN 1 ELSE 0 END) AS en_cours,
        SUM(CASE WHEN statut = 'echouee' THEN 1 ELSE 0 END) AS echouees,
        COALESCE(SUM(frais), 0) AS total_frais
       FROM livraisons WHERE livreur_id = ?`,
      [req.params.id]
    );

    const livraisons = await query(
      `SELECT 
        li.id, li.reference, li.adresse, li.destinataire, li.telephone,
        li.statut, li.frais, li.livree_at, li.created_at,
        c.reference AS commande_ref,
        b.name AS boutique_name
       FROM livraisons li
       JOIN commandes c ON li.commande_id = c.id
       JOIN boutiques b ON c.boutique_id = b.id
       WHERE li.livreur_id = ?
       ORDER BY li.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );

    res.json({ success: true, livreur, stats, livraisons });
  })
);

// ═══════════════════════════════════════════════
// POST /api/livreurs — créer (admin)
// ═══════════════════════════════════════════════
router.post(
  '/',
  requireAdmin,
  validate([
    body('fullname').trim().isLength({ min: 3, max: 100 }).withMessage('Nom requis (3-100 car.)'),
    body('phone').trim().matches(/^\d{8}$/).withMessage('Téléphone 8 chiffres requis'),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('address').optional({ values: 'falsy' }).trim(),
    body('vehicle').optional({ values: 'falsy' }).isIn(VEHICLES),
    body('vehicle_plate').optional({ values: 'falsy' }).trim(),
    body('zone').optional({ values: 'falsy' }).trim(),
    body('notes').optional({ values: 'falsy' }).trim(),
  ]),
  asyncHandler(async (req, res) => {
    const { fullname, phone, email, address, vehicle, vehicle_plate, zone, notes } = req.body;

    const existing = await get('SELECT id FROM livreurs WHERE phone = ?', [phone]);
    if (existing) throw new AppError('Ce téléphone est déjà utilisé', 409, 'PHONE_EXISTS');

    const result = await run(
      `INSERT INTO livreurs
       (fullname, phone, email, address, vehicle, vehicle_plate, zone, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullname.trim(), phone, email || null, address || null,
        vehicle || 'moto', vehicle_plate || null, zone || null, notes || null,
        req.user.userId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'LIVREUR_CREATED',
      resource: 'livreurs',
      resourceId: result.lastID,
      details: { fullname, phone },
      ip: getClientIp(req),
    });

    const livreur = await get('SELECT * FROM livreurs WHERE id = ?', [result.lastID]);

    res.status(201).json({ success: true, message: 'Livreur créé', livreur });
  })
);

// ═══════════════════════════════════════════════
// PUT /api/livreurs/:id — modifier (admin)
// ═══════════════════════════════════════════════
router.put(
  '/:id',
  requireAdmin,
  validate([
    param('id').isInt().toInt(),
    body('fullname').optional({ values: 'falsy' }).trim().isLength({ min: 3, max: 100 }),
    body('phone').optional({ values: 'falsy' }).trim().matches(/^\d{8}$/),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('address').optional({ values: 'falsy' }).trim(),
    body('vehicle').optional({ values: 'falsy' }).isIn(VEHICLES),
    body('vehicle_plate').optional({ values: 'falsy' }).trim(),
    body('zone').optional({ values: 'falsy' }).trim(),
    body('notes').optional({ values: 'falsy' }).trim(),
    body('is_active').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const livreur = await get('SELECT * FROM livreurs WHERE id = ?', [req.params.id]);
    if (!livreur) throw new AppError('Livreur introuvable', 404, 'LIVREUR_NOT_FOUND');

    const { fullname, phone, email, address, vehicle, vehicle_plate, zone, notes, is_active } = req.body;

    if (phone && phone !== livreur.phone) {
      const dup = await get('SELECT id FROM livreurs WHERE phone = ? AND id != ?', [phone, req.params.id]);
      if (dup) throw new AppError('Ce téléphone est déjà utilisé', 409, 'PHONE_EXISTS');
    }

    await run(
      `UPDATE livreurs SET
        fullname = COALESCE(?, fullname),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        vehicle = COALESCE(?, vehicle),
        vehicle_plate = COALESCE(?, vehicle_plate),
        zone = COALESCE(?, zone),
        notes = COALESCE(?, notes),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        fullname, phone, email, address, vehicle, vehicle_plate, zone, notes,
        is_active === undefined ? livreur.is_active : (is_active ? 1 : 0),
        req.params.id,
      ]
    );

    const updated = await get('SELECT * FROM livreurs WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Livreur mis à jour', livreur: updated });
  })
);

// ═══════════════════════════════════════════════
// DELETE /api/livreurs/:id — désactiver (admin)
// ═══════════════════════════════════════════════
router.delete(
  '/:id',
  requireAdmin,
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const livreur = await get('SELECT * FROM livreurs WHERE id = ?', [req.params.id]);
    if (!livreur) throw new AppError('Livreur introuvable', 404, 'LIVREUR_NOT_FOUND');

    const pending = await get(
      `SELECT COUNT(*) AS c FROM livraisons WHERE livreur_id = ? AND statut = 'en_cours'`,
      [req.params.id]
    );
    if (pending.c > 0) {
      throw new AppError(`Impossible : ${pending.c} livraison(s) en cours`, 409, 'LIVREUR_HAS_PENDING');
    }

    await run('UPDATE livreurs SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);

    await logAction({
      userId: req.user.userId,
      action: 'LIVREUR_DEACTIVATED',
      resource: 'livreurs',
      resourceId: req.params.id,
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Livreur désactivé' });
  })
);

module.exports = router;