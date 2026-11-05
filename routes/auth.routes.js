// backend/routes/auth.routes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { body } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { get, run, query } = require('../database/db');
const {
  generateTokens,
  verifyRefreshToken,
  authenticateToken,
  getClientIp,
} = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const REFRESH_EXPIRES_DAYS = 7;

// ─────────────────────────────────────────────
// Utilitaires internes
// ─────────────────────────────────────────────

function sanitizeUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    fullname: user.fullname,
    email: user.email,
    role: user.role,
    province: user.province,
    city: user.city,
    is_active: user.is_active,
    kyc_level: user.kyc_level,
    created_at: user.created_at,
  };
}

async function persistRefreshToken(userId, token) {
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();

  // Nettoyer les anciens tokens expirés de cet utilisateur
  await run(
    `DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < datetime('now')`,
    [userId]
  );

  await run(
    `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`,
    [userId, token, expiresAt]
  );
}

async function revokeRefreshToken(token) {
  await run('DELETE FROM refresh_tokens WHERE token = ?', [token]);
}

async function revokeAllUserTokens(userId) {
  await run('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
}

// ─────────────────────────────────────────────
// POST /api/auth/register
// Inscription publique (rôle 'user' par défaut)
// ─────────────────────────────────────────────
router.post(
  '/register',
  validate([
    body('phone')
      .trim()
      .matches(/^\d{8}$/)
      .withMessage('Le téléphone doit contenir 8 chiffres'),
    body('fullname').trim().isLength({ min: 3, max: 100 }).withMessage('Nom complet requis (3-100 car.)'),
    body('password').isLength({ min: 6 }).withMessage('Mot de passe minimum 6 caractères'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Email invalide'),
    body('role').not().exists().withMessage('Le rôle ne peut pas être défini à l\'inscription'),
  ]),
  asyncHandler(async (req, res) => {
    const { phone, fullname, password, email, province, city, address } = req.body;

    const existing = await get('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing) {
      throw new AppError('Ce numéro de téléphone est déjà enregistré', 409, 'PHONE_ALREADY_EXISTS');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await run(
      `INSERT INTO users (phone, fullname, email, password_hash, role, province, city, address, is_active)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 1)`,
      [phone, fullname.trim(), email || null, passwordHash, province || null, city || null, address || null]
    );

    const user = await get('SELECT * FROM users WHERE id = ?', [result.lastID]);

    const { accessToken, refreshToken } = generateTokens(user);
    await persistRefreshToken(user.id, refreshToken);

    await logAction({
      userId: user.id,
      action: 'USER_REGISTERED',
      resource: 'users',
      resourceId: user.id,
      details: { phone },
      ip: getClientIp(req),
    });

    // Notification de bienvenue
    await run(
      `INSERT INTO notifications (user_id, title, message, type, category)
       VALUES (?, '🎉 Bienvenue', 'Bienvenue sur khamis GLOBAL GROUP ACHETEZ TOUS CE QUE VOUS DESIREZ !', 'success', 'general')`,
      [user.id]
    );

    res.status(201).json({
      success: true,
      message: 'Inscription réussie',
      user: sanitizeUser(user),
      tokens: { accessToken, refreshToken },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────
router.post(
  '/login',
  validate([
    body('phone').trim().matches(/^\d{8}$/).withMessage('Téléphone invalide (8 chiffres)'),
    body('password').notEmpty().withMessage('Mot de passe requis'),
  ]),
  asyncHandler(async (req, res) => {
    const { phone, password } = req.body;

    const user = await get('SELECT * FROM users WHERE phone = ?', [phone]);

    if (!user) {
      // Message générique pour ne pas révéler l'existence du compte
      throw new AppError('Téléphone ou mot de passe incorrect', 401, 'INVALID_CREDENTIALS');
    }

    if (user.is_active !== 1) {
      throw new AppError('Compte désactivé. Contactez l\'administrateur.', 403, 'ACCOUNT_INACTIVE');
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      throw new AppError('Téléphone ou mot de passe incorrect', 401, 'INVALID_CREDENTIALS');
    }

    // Mettre à jour last_login
    await run('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [user.id]);

    const { accessToken, refreshToken } = generateTokens(user);
    await persistRefreshToken(user.id, refreshToken);

    await logAction({
      userId: user.id,
      action: 'USER_LOGIN',
      resource: 'users',
      resourceId: user.id,
      ip: getClientIp(req),
    });

    res.json({
      success: true,
      message: 'Connexion réussie',
      user: sanitizeUser(user),
      tokens: { accessToken, refreshToken },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────
router.post(
  '/refresh',
  validate([body('refreshToken').notEmpty().withMessage('Refresh token requis')]),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    // Vérifier la signature
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      throw new AppError('Refresh token invalide ou expiré', 401, 'REFRESH_INVALID');
    }

    // Vérifier en base (non révoqué)
    const record = await get(
      'SELECT * FROM refresh_tokens WHERE token = ? AND user_id = ?',
      [refreshToken, decoded.userId]
    );
    if (!record) {
      throw new AppError('Session expirée, reconnectez-vous', 401, 'SESSION_EXPIRED');
    }

    // Vérifier l'expiration en base (double sécurité)
    const expiresAt = new Date(record.expires_at);
    if (expiresAt < new Date()) {
      await revokeRefreshToken(refreshToken);
      throw new AppError('Session expirée, reconnectez-vous', 401, 'SESSION_EXPIRED');
    }

    const user = await get('SELECT * FROM users WHERE id = ?', [decoded.userId]);
    if (!user || user.is_active !== 1) {
      throw new AppError('Compte inactif ou introuvable', 403, 'ACCOUNT_INACTIVE');
    }

    // Rotation : révoquer l'ancien, créer de nouveaux
    await revokeRefreshToken(refreshToken);
    const tokens = generateTokens(user);
    await persistRefreshToken(user.id, tokens.refreshToken);

    res.json({
      success: true,
      tokens,
      user: sanitizeUser(user),
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────
router.post(
  '/logout',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    } else {
      await revokeAllUserTokens(req.user.userId);
    }

    await logAction({
      userId: req.user.userId,
      action: 'USER_LOGOUT',
      resource: 'users',
      resourceId: req.user.userId,
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Déconnexion réussie' });
  })
);

// ─────────────────────────────────────────────
// GET /api/auth/me — profil courant
// ─────────────────────────────────────────────
router.get(
  '/me',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const user = await get(
      `SELECT id, phone, fullname, email, role, province, city, address,
              is_active, kyc_level, last_login, created_at
       FROM users WHERE id = ?`,
      [req.user.userId]
    );
    if (!user) throw new AppError('Utilisateur introuvable', 404, 'USER_NOT_FOUND');

    res.json({ success: true, user });
  })
);

// ─────────────────────────────────────────────
// PUT /api/auth/me — mise à jour du profil
// ─────────────────────────────────────────────
router.put(
  '/me',
  authenticateToken,
  validate([
    body('fullname').optional().trim().isLength({ min: 3, max: 100 }),
    body('email').optional({ checkFalsy: true }).isEmail(),
    body('province').optional().trim().isLength({ max: 100 }),
    body('city').optional().trim().isLength({ max: 100 }),
    body('address').optional().trim().isLength({ max: 255 }),
  ]),
  asyncHandler(async (req, res) => {
    const { fullname, email, province, city, address } = req.body;

    await run(
      `UPDATE users SET
        fullname = COALESCE(?, fullname),
        email    = COALESCE(?, email),
        province = COALESCE(?, province),
        city     = COALESCE(?, city),
        address  = COALESCE(?, address),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [fullname, email, province, city, address, req.user.userId]
    );

    const user = await get(
      'SELECT id, phone, fullname, email, role, province, city, address FROM users WHERE id = ?',
      [req.user.userId]
    );

    res.json({ success: true, message: 'Profil mis à jour', user });
  })
);

// ─────────────────────────────────────────────
// POST /api/auth/change-password
// ─────────────────────────────────────────────
router.post(
  '/change-password',
  authenticateToken,
  validate([
    body('oldPassword').notEmpty().withMessage('Ancien mot de passe requis'),
    body('newPassword').isLength({ min: 6 }).withMessage('Nouveau mot de passe : min 6 car.'),
  ]),
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (oldPassword === newPassword) {
      throw new AppError('Le nouveau mot de passe doit être différent', 400, 'SAME_PASSWORD');
    }

    const user = await get('SELECT password_hash FROM users WHERE id = ?', [req.user.userId]);
    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) {
      throw new AppError('Ancien mot de passe incorrect', 401, 'INVALID_OLD_PASSWORD');
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await run('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hash, req.user.userId]);

    // Révoquer toutes les sessions pour forcer une reconnexion
    await revokeAllUserTokens(req.user.userId);

    await logAction({
      userId: req.user.userId,
      action: 'PASSWORD_CHANGED',
      resource: 'users',
      resourceId: req.user.userId,
      ip: getClientIp(req),
    });

    res.json({
      success: true,
      message: 'Mot de passe modifié. Reconnectez-vous sur les autres appareils.',
    });
  })
);

module.exports = router;