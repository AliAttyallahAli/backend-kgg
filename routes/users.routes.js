// backend/routes/users.routes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const VALID_ROLES = ['admin', 'gerant', 'agent', 'user'];

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════
function cleanId(v) {
  if (v === undefined || v === null || v === '' || v === 'null') return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function cleanStr(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === 'undefined') return undefined;
  return s;
}

// ═══════════════════════════════════════════════
// ⚠️ ROUTES PUBLIQUES AUTHENTIFIÉES (AVANT requireAdmin)
// Accessibles à tous les rôles connectés pour alimenter les dropdowns
// ═══════════════════════════════════════════════

// GET /api/users/for-select — liste simplifiée pour dropdowns
router.get(
  '/for-select',
  authenticateToken,
  validate([
    qv('role').optional({ values: 'falsy' }).isIn([...VALID_ROLES, 'all']),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const role = req.query.role;
    const search = cleanStr(req.query.search);
    const limit = parseInt(req.query.limit, 10) || 100;

    const conditions = ['is_active = 1'];
    const params = [];

    if (role && role !== 'all') {
      conditions.push('role = ?');
      params.push(role);
    }
    if (search) {
      conditions.push('(fullname LIKE ? OR phone LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s);
    }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT id, fullname, phone, role
       FROM users
       WHERE ${where}
       ORDER BY fullname ASC
       LIMIT ?`,
      [...params, limit]
    );

    res.json({ success: true, data: rows });
  })
);

// ═══════════════════════════════════════════════
// ⚠️ À PARTIR D'ICI : réservé aux admins
// ═══════════════════════════════════════════════
router.use(authenticateToken, requireAdmin);

// ─────────────────────────────────────────────
// GET /api/users — liste paginée + filtres
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 1000 }).toInt(),
    qv('role').optional({ values: 'falsy' }).isIn([...VALID_ROLES, 'all']),
    qv('is_active').optional({ values: 'falsy' }).isIn(['0', '1', 'all']),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const role = req.query.role;
    const isActive = req.query.is_active;
    const search = cleanStr(req.query.search);

    const conditions = ['1=1'];
    const params = [];

    // Filtre rôle (ignorer si 'all' ou absent)
    if (role && role !== 'all') {
      conditions.push('role = ?');
      params.push(role);
    }

    // Filtre statut actif (ignorer si 'all' ou absent)
    if (isActive !== undefined && isActive !== null && isActive !== 'all') {
      const n = parseInt(isActive, 10);
      if (!isNaN(n)) {
        conditions.push('is_active = ?');
        params.push(n);
      }
    }

    if (search) {
      conditions.push('(fullname LIKE ? OR phone LIKE ? OR email LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(`SELECT COUNT(*) AS total FROM users WHERE ${where}`, params);

    const rows = await query(
      `SELECT id, phone, fullname, email, role, province, city,
              is_active, kyc_level, last_login, created_at
       FROM users
       WHERE ${where}
       ORDER BY created_at DESC
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
// GET /api/users/stats/overview
// ⚠️ AVANT /:id
// ─────────────────────────────────────────────
router.get(
  '/stats/overview',
  asyncHandler(async (req, res) => {
    const rows = await query(`
      SELECT role, COUNT(*) AS count,
             SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS actifs
      FROM users GROUP BY role
    `);
    const totalRow = await get('SELECT COUNT(*) AS total FROM users');
    const recentRow = await get(
      `SELECT COUNT(*) AS c FROM users WHERE created_at >= datetime('now','-30 days')`
    );

    res.json({
      success: true,
      total: totalRow.total,
      nouveaux_30j: recentRow.c,
      par_role: rows.reduce((acc, r) => {
        acc[r.role] = { total: r.count, actifs: r.actifs };
        return acc;
      }, {}),
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/users/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const user = await get(
      `SELECT id, phone, fullname, email, role, province, city, address,
              is_active, kyc_level, last_login, created_at, updated_at
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!user) throw new AppError('Utilisateur introuvable', 404, 'USER_NOT_FOUND');
    res.json({ success: true, user });
  })
);

// ─────────────────────────────────────────────
// POST /api/users — création
// ─────────────────────────────────────────────
router.post(
  '/',
  validate([
    body('phone').trim().matches(/^\d{8}$/).withMessage('Téléphone invalide (8 chiffres)'),
    body('fullname').trim().isLength({ min: 3, max: 100 }),
    body('password').isLength({ min: 6 }),
    body('role').isIn(VALID_ROLES),
    body('email').optional({ values: 'falsy' }).isEmail(),
  ]),
  asyncHandler(async (req, res) => {
    const { phone, fullname, password, role, email, province, city, address } = req.body;

    const existing = await get('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing) throw new AppError('Ce téléphone est déjà enregistré', 409, 'PHONE_ALREADY_EXISTS');

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await run(
      `INSERT INTO users (phone, fullname, email, password_hash, role, province, city, address, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [phone, fullname.trim(), email || null, hash, role, province || null, city || null, address || null]
    );

    const user = await get('SELECT * FROM users WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'USER_CREATED',
      resource: 'users',
      resourceId: user.id,
      details: { phone, role },
      ip: getClientIp(req),
    });

    res.status(201).json({
      success: true,
      message: 'Utilisateur créé',
      user: { id: user.id, phone: user.phone, fullname: user.fullname, role: user.role },
    });
  })
);

// ─────────────────────────────────────────────
// PUT /api/users/:id — mise à jour
// ─────────────────────────────────────────────
router.put(
  '/:id',
  validate([
    param('id').isInt().toInt(),
    body('fullname').optional({ values: 'falsy' }).trim().isLength({ min: 3, max: 100 }),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('role').optional({ values: 'falsy' }).isIn(VALID_ROLES),
    body('province').optional({ values: 'falsy' }).trim(),
    body('city').optional({ values: 'falsy' }).trim(),
    body('address').optional({ values: 'falsy' }).trim(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { fullname, email, role, province, city, address } = req.body;

    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) throw new AppError('Utilisateur introuvable', 404, 'USER_NOT_FOUND');

    if (targetId === req.user.userId && role && role !== 'admin') {
      throw new AppError('Vous ne pouvez pas retirer votre propre rôle admin', 400, 'SELF_DEMOTE');
    }

    if (target.role === 'admin' && role && role !== 'admin') {
      const adminCount = await get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1`);
      if (adminCount.c <= 1) throw new AppError('Impossible : dernier admin actif', 400, 'LAST_ADMIN');
    }

    await run(
      `UPDATE users SET
        fullname = COALESCE(?, fullname),
        email    = COALESCE(?, email),
        role     = COALESCE(?, role),
        province = COALESCE(?, province),
        city     = COALESCE(?, city),
        address  = COALESCE(?, address),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [fullname, email, role, province, city, address, targetId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'USER_UPDATED',
      resource: 'users',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const user = await get(
      'SELECT id, phone, fullname, email, role, province, city, address, is_active FROM users WHERE id = ?',
      [targetId]
    );
    res.json({ success: true, message: 'Utilisateur mis à jour', user });
  })
);

// ─────────────────────────────────────────────
// PATCH /api/users/:id/toggle-active
// ─────────────────────────────────────────────
router.patch(
  '/:id/toggle-active',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    if (targetId === req.user.userId) {
      throw new AppError('Vous ne pouvez pas désactiver votre propre compte', 400, 'SELF_DEACTIVATE');
    }

    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) throw new AppError('Utilisateur introuvable', 404, 'USER_NOT_FOUND');

    if (target.role === 'admin' && target.is_active === 1) {
      const admins = await get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1`);
      if (admins.c <= 1) throw new AppError('Impossible : dernier admin actif', 400, 'LAST_ADMIN');
    }

    const newStatus = target.is_active === 1 ? 0 : 1;
    await run('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, targetId]);

    if (newStatus === 0) {
      await run('DELETE FROM refresh_tokens WHERE user_id = ?', [targetId]);
    }

    await logAction({
      userId: req.user.userId,
      action: newStatus === 1 ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      resource: 'users',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    res.json({
      success: true,
      message: newStatus === 1 ? 'Utilisateur activé' : 'Utilisateur désactivé',
      is_active: newStatus,
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/users/:id/reset-password
// ─────────────────────────────────────────────
router.post(
  '/:id/reset-password',
  validate([
    param('id').isInt().toInt(),
    body('newPassword').optional({ values: 'falsy' }).isLength({ min: 6 }),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) throw new AppError('Utilisateur introuvable', 404, 'USER_NOT_FOUND');

    const plainPassword = req.body.newPassword || Math.random().toString(36).slice(-10);
    const hash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

    await run('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hash, targetId]);

    await run('DELETE FROM refresh_tokens WHERE user_id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'PASSWORD_RESET_BY_ADMIN',
      resource: 'users',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    await run(
      `INSERT INTO notifications (user_id, title, message, type, category)
       VALUES (?, '🔐 Mot de passe réinitialisé',
              'Votre mot de passe a été réinitialisé par un administrateur.',
              'warning', 'security')`,
      [targetId]
    );

    res.json({
      success: true,
      message: 'Mot de passe réinitialisé',
      generatedPassword: !req.body.newPassword ? plainPassword : undefined,
    });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/users/:id
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    if (targetId === req.user.userId) {
      throw new AppError('Vous ne pouvez pas supprimer votre propre compte', 400, 'SELF_DELETE');
    }

    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) throw new AppError('Utilisateur introuvable', 404, 'USER_NOT_FOUND');

    if (target.role === 'admin') {
      const admins = await get(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`);
      if (admins.c <= 1) throw new AppError('Impossible : dernier admin', 400, 'LAST_ADMIN');
    }

    await run('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [targetId]);
    await run('DELETE FROM refresh_tokens WHERE user_id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'USER_DELETED',
      resource: 'users',
      resourceId: targetId,
      details: { phone: target.phone },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Utilisateur supprimé (désactivé)' });
  })
);

module.exports = router;