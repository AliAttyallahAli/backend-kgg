// backend/routes/khamis-alkherpay.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { authenticateToken } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { get, run } = require('../database/db');
const alkherpay = require('../services/alkherpayClient');

router.use(authenticateToken);
// ═══════════════════════════════════════════════
// GET /api/khamis/paiements/solde
// ⚠️ NE DOIT JAMAIS RENVOYER 500
// ═══════════════════════════════════════════════
router.get(
  '/solde',
  requirePermission('paiements_alkherpay', 'read'),
  asyncHandler(async (req, res) => {
    console.log('🔍 [solde] User', req.user.userId, 'demande son solde AlkherPay');

    try {
      // 1. Récupérer le user en base
      const user = await get(
        'SELECT id, phone, fullname, alkherpay_phone FROM users WHERE id = ?',
        [req.user.userId]
      );

      if (!user) {
        return res.json({
          success: true,
          linked: false,
          requiresLink: true,
          wallet: {
            balance: 0,
            currency: 'XAF',
            fullname: null,
            phone: null,
            alkherpay_phone: null,
            message: 'Utilisateur introuvable.',
          },
        });
      }

      // 2. Vérifier si le user a un compte AlkherPay lié
      if (!user.alkherpay_phone) {
        console.log('⚠️ [solde] User non lié à AlkherPay');
        return res.json({
          success: true,
          linked: false,
          requiresLink: true,
          wallet: {
            balance: 0,
            currency: 'XAF',
            fullname: user.fullname,
            phone: user.phone,
            alkherpay_phone: null,
            message: 'Aucun compte AlkherPay lié. Créez-en un pour effectuer des transferts.',
          },
        });
      }

      // 3. Appeler AlkherPay (avec timeout court)
      console.log('🔍 [solde] Appel AlkherPay pour', user.alkherpay_phone);

      try {
        const wallet = await alkherpay.getUserSolde(req.user.userId);
        console.log('✅ [solde] Succès :', wallet);
        return res.json({
          success: true,
          linked: true,
          wallet,
        });
      } catch (alkherErr) {
        // AlkherPay a planté → renvoyer un solde dégradé (pas 500)
        console.warn('⚠️ [solde] AlkherPay indisponible :', alkherErr.message);

        return res.json({
          success: true,
          linked: true,
          degraded: true,
          wallet: {
            balance: 0,
            currency: 'XAF',
            fullname: user.fullname,
            phone: user.alkherpay_phone,
            alkherpay_phone: user.alkherpay_phone,
            message: 'Service AlkherPay temporairement indisponible.',
            error: alkherErr.message,
          },
        });
      }
    } catch (err) {
      // Erreur inattendue (SQL, etc.) → renvoyer quand même 200
      console.error('❌ [solde] Erreur critique :', err);

      return res.json({
        success: false,
        linked: false,
        requiresLink: false,
        wallet: {
          balance: 0,
          currency: 'XAF',
          fullname: null,
          phone: null,
          alkherpay_phone: null,
          message: 'Erreur de chargement du solde.',
          error: err.message,
        },
      });
    }
  })
);

// ═══════════════════════════════════════════════
// GET /api/khamis/paiements/pin-status
// ═══════════════════════════════════════════════
router.get(
  '/pin-status',
  requirePermission('paiements_alkherpay', 'read'),
  asyncHandler(async (req, res) => {
    try {
      const status = await alkherpay.getUserPinStatus(req.user.userId);
      res.json({
        success: true,
        hasPin: status.hasPin || false,
        isPinSet: status.isPinSet || false,
        linked: status.linked !== false,
      });
    } catch (err) {
      res.json({
        success: false,
        hasPin: false,
        isPinSet: false,
        error: err.message,
      });
    }
  })
);

// ═══════════════════════════════════════════════
// POST /api/khamis/paiements/set-pin
// ═══════════════════════════════════════════════
router.post(
  '/set-pin',
  requirePermission('paiements_alkherpay', 'execute'),
  validate([
    body('pin').matches(/^\d{4}$/).withMessage('PIN 4 chiffres requis'),
    body('confirmPin').matches(/^\d{4}$/).withMessage('Confirmation requise'),
  ]),
  asyncHandler(async (req, res) => {
    const { pin, confirmPin } = req.body;

    if (pin !== confirmPin) {
      return res.status(400).json({
        success: false,
        error: 'Les deux PIN ne correspondent pas',
        code: 'PIN_MISMATCH',
      });
    }

    const weakPins = ['0000', '1111', '1234', '4321', '9999', '2222'];
    if (weakPins.includes(pin)) {
      return res.status(400).json({
        success: false,
        error: 'PIN trop simple. Choisissez un autre code.',
        code: 'PIN_TOO_WEAK',
      });
    }

    try {
      await alkherpay.setUserPin(req.user.userId, { pin });
      res.json({ success: true, message: 'PIN défini' });
    } catch (err) {
      res.status(err.response?.status || 500).json({
        success: false,
        error: err.message,
        code: err.code || 'PIN_SET_ERROR',
      });
    }
  })
);

// ═══════════════════════════════════════════════
// POST /api/khamis/paiements/verify-pin
// ═══════════════════════════════════════════════
router.post(
  '/verify-pin',
  requirePermission('paiements_alkherpay', 'execute'),
  validate([
    body('pin').matches(/^\d{4}$/).withMessage('PIN 4 chiffres requis'),
  ]),
  asyncHandler(async (req, res) => {
    try {
      await alkherpay.verifyUserPin(req.user.userId, { pin: req.body.pin });
      res.json({ success: true, valid: true });
    } catch (err) {
      res.status(err.response?.status || 401).json({
        success: false,
        valid: false,
        error: err.message,
        code: err.code || 'PIN_INVALID',
        attemptsRemaining: err.response?.data?.attemptsRemaining,
        blockedUntil: err.response?.data?.blockedUntil,
      });
    }
  })
);

// ═══════════════════════════════════════════════
// POST /api/khamis/paiements/transfert
// ═══════════════════════════════════════════════
router.post(
  '/transfert',
  requirePermission('paiements_alkherpay', 'execute'),
  validate([
    body('receiver_phone').matches(/^\d{8}$/).withMessage('Téléphone destinataire invalide'),
    body('amount').isInt({ min: 25 }).toInt().withMessage('Montant min 25 FCFA'),
    body('pin').matches(/^\d{4}$/).withMessage('PIN 4 chiffres requis'),
    body('description').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
  ]),
  asyncHandler(async (req, res) => {
    const { receiver_phone, amount, description, pin } = req.body;

    try {
      const data = await alkherpay.transfert(req.user.userId, {
        receiver_phone,
        amount,
        description,
        pin,
      });
      res.json({ success: true, transaction: data });
    } catch (err) {
      const status = err.response?.status || err.status || 500;
      const code = err.code || err.response?.data?.code || 'TRANSFER_ERROR';

      // Cas spécial : compte non lié
      if (code === 'NO_ALKHERPAY_ACCOUNT') {
        return res.status(403).json({
          success: false,
          error: err.message,
          code,
          requiresLink: true,
        });
      }

      res.status(status).json({
        success: false,
        error: err.message,
        code,
        attemptsRemaining: err.response?.data?.attemptsRemaining,
        blockedUntil: err.response?.data?.blockedUntil,
      });
    }
  })
);

// ═══════════════════════════════════════════════
// GET /api/khamis/paiements/historique
// ═══════════════════════════════════════════════
router.get(
  '/historique',
  requirePermission('paiements_alkherpay', 'read'),
  validate([
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 200 }).toInt(),
    qv('offset').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    try {
      const data = await alkherpay.getUserHistorique(req.user.userId, {
        limit: parseInt(req.query.limit, 10) || 50,
        offset: parseInt(req.query.offset, 10) || 0,
      });
      res.json({ success: true, ...data });
    } catch (err) {
      res.json({ success: true, transactions: [], total: 0, linked: false });
    }
  })
);

// ═══════════════════════════════════════════════
// POST /api/khamis/paiements/link
// Lier un compte AlkherPay existant
// ═══════════════════════════════════════════════
router.post(
  '/link',
  requirePermission('paiements_alkherpay', 'read'),
  validate([
    body('alkherpay_phone').matches(/^\d{8}$/).withMessage('Numéro AlkherPay invalide (8 chiffres)'),
  ]),
  asyncHandler(async (req, res) => {
    try {
      const result = await alkherpay.linkAlkherPayAccount(
        req.user.userId,
        req.body.alkherpay_phone
      );
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({
        success: false,
        error: err.message,
        code: err.code,
      });
    }
  })
);

// ═══════════════════════════════════════════════
// POST /api/khamis/paiements/request-account
// Demander la création d'un compte AlkherPay
// ═══════════════════════════════════════════════
router.post(
  '/request-account',
  requirePermission('paiements_alkherpay', 'read'),
  validate([
    body('requested_phone').optional({ values: 'falsy' }).matches(/^\d{8}$/),
  ]),
  asyncHandler(async (req, res) => {
    const { requested_phone } = req.body;

    try {
      // Vérifier qu'il n'y a pas déjà une demande
      const existing = await get(
        `SELECT id FROM alkherpay_account_requests 
         WHERE user_id = ? AND status = 'pending'`,
        [req.user.userId]
      );

      if (existing) {
        return res.status(400).json({
          success: false,
          error: 'Vous avez déjà une demande en attente',
        });
      }

      // Créer la demande
      await run(
        `INSERT INTO alkherpay_account_requests (user_id, requested_phone)
         VALUES (?, ?)`,
        [req.user.userId, requested_phone || req.user.phone]
      );

      // Notifier les admins
      const admins = await require('../database/db').query(
        `SELECT id FROM users WHERE role = 'admin' AND is_active = 1`
      );

      for (const admin of admins) {
        await run(
          `INSERT INTO notifications (user_id, title, message, type, category)
           VALUES (?, '💳 Demande compte AlkherPay', ?, 'info', 'alkherpay')`,
          [
            admin.id,
            `${req.user.fullname} (${req.user.phone}) demande la création d'un compte AlkherPay`,
          ]
        );
      }

      res.json({
        success: true,
        message: 'Demande envoyée. Un administrateur créera votre compte AlkherPay.',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  })
);

// ═══════════════════════════════════════════════
// GET /api/khamis/paiements/request-status
// ═══════════════════════════════════════════════
router.get(
  '/request-status',
  requirePermission('paiements_alkherpay', 'read'),
  asyncHandler(async (req, res) => {
    const request = await get(
      `SELECT * FROM alkherpay_account_requests 
       WHERE user_id = ? 
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.userId]
    );

    res.json({
      success: true,
      request: request || null,
      hasPending: request?.status === 'pending',
    });
  })
);

module.exports = router;