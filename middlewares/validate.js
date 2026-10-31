// backend/middlewares/validate.js
const { validationResult } = require('express-validator');

// ─────────────────────────────────────────────
// Middleware générique de validation
// ─────────────────────────────────────────────
function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Données invalides',
          code: 'VALIDATION_ERROR',
          details: errors.array().map((e) => ({
            field: e.path,
            message: e.msg,
            value: e.value,
          })),
        });
      }
      next();
    },
  ];
}

// ─────────────────────────────────────────────
// Validation conditionnelle
// ─────────────────────────────────────────────
function validateIf(condition, rules) {
  return (req, res, next) => {
    if (!condition(req)) return next();
    const middlewares = validate(rules);
    let idx = 0;
    const runNext = (err) => {
      if (err) return next(err);
      if (idx >= middlewares.length) return next();
      const mw = middlewares[idx++];
      mw(req, res, runNext);
    };
    runNext();
  };
}

module.exports = { validate, validateIf };