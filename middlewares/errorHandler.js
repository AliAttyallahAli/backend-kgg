// backend/middlewares/errorHandler.js
const { getClientIp } = require('./auth');
const { run } = require('../database/db');

// ─────────────────────────────────────────────
// Classe AppError personnalisée
// ─────────────────────────────────────────────
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─────────────────────────────────────────────
// Handler 404 (routes non trouvées)
// ─────────────────────────────────────────────
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route non trouvée : ${req.method} ${req.originalUrl}`,
    code: 'ROUTE_NOT_FOUND',
  });
}

// ─────────────────────────────────────────────
// Handler global d'erreurs
// ─────────────────────────────────────────────
async function errorHandler(err, req, res, next) {
  // Log serveur
  console.error('❌ [ErrorHandler]', {
    message: err.message,
    code: err.code,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.originalUrl,
    method: req.method,
  });

  // Journaliser en base (best-effort)
  try {
    if (req.user?.userId) {
      await run(
        `INSERT INTO audit_logs (user_id, action, resource, details, ip)
         VALUES (?, 'ERROR', ?, ?, ?)`,
        [
          req.user.userId,
          req.originalUrl,
          JSON.stringify({ message: err.message, code: err.code }),
          getClientIp(req),
        ]
      );
    }
  } catch (_) {
    // ignore
  }

  // Erreurs de contrainte SQLite
  if (err.code === 'SQLITE_CONSTRAINT' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({
      success: false,
      error: 'Conflit de données (valeur déjà existante ou contrainte violée)',
      code: 'DB_CONSTRAINT',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }

  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({
      success: false,
      error: 'Référence invalide (élément lié inexistant)',
      code: 'DB_FOREIGN_KEY',
    });
  }

  // Erreurs JWT
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: 'Token invalide',
      code: 'JWT_INVALID',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Token expiré',
      code: 'JWT_EXPIRED',
    });
  }

  // Erreurs AppError opérationnelles
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }

  // Erreur inconnue
  res.status(err.statusCode || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === 'production'
        ? 'Erreur interne du serveur'
        : err.message,
    code: 'INTERNAL_ERROR',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
}

// ─────────────────────────────────────────────
// Wrapper async (évite les try/catch partout)
// ─────────────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  AppError,
  notFoundHandler,
  errorHandler,
  asyncHandler,
};