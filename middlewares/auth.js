// backend/middlewares/auth.js
const jwt = require('jsonwebtoken');
const { get } = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'khamis_super_secret_key_CHANGE_ME_2024';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'khamis_refresh_secret_CHANGE_ME_2024';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// ─────────────────────────────────────────────
// Génération des tokens
// ─────────────────────────────────────────────
function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      phone: user.phone,
      role: user.role,
      fullname: user.fullname,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    { userId: user.id, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN }
  );
}

function generateTokens(user) {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user),
  };
}

// ─────────────────────────────────────────────
// Vérification du refresh token
// ─────────────────────────────────────────────
function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}

// ─────────────────────────────────────────────
// Middleware : authentifier la requête
// ─────────────────────────────────────────────
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Token d\'authentification requis',
      code: 'AUTH_TOKEN_MISSING',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Vérifier que l'utilisateur existe toujours et est actif
    const user = await get(
      'SELECT id, phone, fullname, email, role, is_active, kyc_level FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur introuvable',
        code: 'AUTH_USER_NOT_FOUND',
      });
    }

    if (user.is_active !== 1) {
      return res.status(403).json({
        success: false,
        error: 'Compte désactivé. Contactez l\'administrateur.',
        code: 'AUTH_USER_INACTIVE',
      });
    }

    // Attacher l'utilisateur à la requête
    req.user = {
      userId: user.id,
      id: user.id,
      phone: user.phone,
      fullname: user.fullname,
      email: user.email,
      role: user.role,
      kyc_level: user.kyc_level,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expiré. Reconnectez-vous.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }
    return res.status(403).json({
      success: false,
      error: 'Token invalide',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
}

// ─────────────────────────────────────────────
// Middleware : authentification optionnelle
// (pour routes publiques qui enrichissent si connecté)
// ─────────────────────────────────────────────
async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await get(
      'SELECT id, phone, fullname, role, is_active FROM users WHERE id = ?',
      [decoded.userId]
    );
    if (user && user.is_active === 1) {
      req.user = {
        userId: user.id,
        id: user.id,
        phone: user.phone,
        fullname: user.fullname,
        role: user.role,
      };
    }
  } catch (_) {
    // Ignore : pas d'auth valide
  }
  next();
}

// ─────────────────────────────────────────────
// Helper : extraire l'IP de la requête
// ─────────────────────────────────────────────
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  verifyRefreshToken,
  authenticateToken,
  optionalAuth,
  getClientIp,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
};