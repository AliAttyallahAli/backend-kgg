// backend/routes/partenaires.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requireAdmin, requireGerantOrAdmin } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

router.use(authenticateToken);

const PAYMENT_TERMS = ['comptant', '30j', '45j', '60j', '90j', 'autre'];
const CATEGORIES = ['grossiste', 'detaillant', 'fabricant', 'importateur', 'autre'];

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════
function generateCode() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `PART-${n}`;
}

// ═══════════════════════════════════════════════
// GET /api/partenaires — liste paginée
// ═══════════════════════════════════════════════
router.get(
  '/',
  requireGerantOrAdmin,
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 200 }).toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('is_active').optional({ values: 'falsy' }).isIn(['0', '1', 'all']),
    qv('category').optional({ values: 'falsy' }).isIn([...CATEGORIES, 'all']),
    qv('sort').optional({ values: 'falsy' }).isIn(['name', 'recent', 'montant', 'achats']),
    qv('order').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const isActive = req.query.is_active;
    const category = req.query.category;
    const sort = req.query.sort || 'name';
    const order = (req.query.order || 'asc').toUpperCase();

    const conditions = ['1=1'];
    const params = [];

    if (search) {
      conditions.push('(p.name LIKE ? OR p.company_name LIKE ? OR p.phone LIKE ? OR p.email LIKE ? OR p.contact_name LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (isActive && isActive !== 'all') {
      conditions.push('p.is_active = ?');
      params.push(parseInt(isActive, 10));
    }
    if (category && category !== 'all') {
      conditions.push('p.category = ?');
      params.push(category);
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM partenaires p WHERE ${where}`,
      params
    );

    let orderBy = 'p.name ASC';
    if (sort === 'name') orderBy = `p.name ${order}`;
    else if (sort === 'recent') orderBy = `p.created_at ${order}`;
    else if (sort === 'montant') orderBy = 'total_montant DESC';
    else if (sort === 'achats') orderBy = 'total_achats DESC';

    const rows = await query(
      `SELECT
        p.id, p.code, p.name, p.company_name, p.contact_name,
        p.phone, p.phone_secondary, p.email, p.address, p.city, p.province,
        p.category, p.payment_terms, p.is_active, p.rating, p.created_at,
        COALESCE((SELECT COUNT(*) FROM partenaire_achats WHERE partenaire_id = p.id), 0) AS total_achats,
        COALESCE((SELECT SUM(total) FROM partenaire_achats WHERE partenaire_id = p.id), 0) AS total_montant,
        (SELECT MAX(date_achat) FROM partenaire_achats WHERE partenaire_id = p.id) AS dernier_achat
       FROM partenaires p
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
// GET /api/partenaires/options — liste simple pour dropdown
// ⚠️ AVANT /:id
// ═══════════════════════════════════════════════
router.get(
  '/options',
  requireGerantOrAdmin,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, code, name, phone, company_name
       FROM partenaires WHERE is_active = 1
       ORDER BY name ASC`
    );
    res.json({ success: true, data: rows });
  })
);

// ═══════════════════════════════════════════════
// GET /api/partenaires/stats — KPIs globaux
// ⚠️ AVANT /:id
// ═══════════════════════════════════════════════
router.get(
  '/stats',
  requireGerantOrAdmin,
  asyncHandler(async (req, res) => {
    const stats = await get(
      `SELECT
        COUNT(*) AS total_partenaires,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS actifs,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactifs
       FROM partenaires`
    );

    const achatsStats = await get(
      `SELECT
        COUNT(*) AS total_achats,
        COALESCE(SUM(total), 0) AS total_montant,
        COALESCE(SUM(CASE WHEN statut_paiement != 'paye' THEN total - montant_paye ELSE 0 END), 0) AS montant_du
       FROM partenaire_achats`
    );

    res.json({
      success: true,
      partenaires: stats || { total_partenaires: 0, actifs: 0, inactifs: 0 },
      achats: achatsStats || { total_achats: 0, total_montant: 0, montant_du: 0 },
    });
  })
);

// ═══════════════════════════════════════════════
// GET /api/partenaires/:id — détail + achats
// ═══════════════════════════════════════════════
router.get(
  '/:id',
  requireGerantOrAdmin,
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const partenaire = await get('SELECT * FROM partenaires WHERE id = ?', [req.params.id]);
    if (!partenaire) throw new AppError('Partenaire introuvable', 404, 'PARTENAIRE_NOT_FOUND');

    // Stats
    const stats = await get(
      `SELECT
        COUNT(*) AS total_achats,
        COALESCE(SUM(total), 0) AS total_montant,
        COALESCE(SUM(montant_paye), 0) AS total_paye,
        COALESCE(SUM(CASE WHEN statut_paiement != 'paye' THEN total - montant_paye ELSE 0 END), 0) AS montant_du,
        MAX(date_achat) AS dernier_achat
       FROM partenaire_achats WHERE partenaire_id = ?`,
      [req.params.id]
    );

    // Achats récents
    const achats = await query(
      `SELECT
        pa.id, pa.reference, pa.quantite, pa.prix_unitaire, pa.total,
        pa.date_achat, pa.moyen_paiement, pa.statut_paiement, pa.montant_paye, pa.notes,
        p.name AS produit_name, p.reference AS produit_ref,
        b.name AS boutique_name
       FROM partenaire_achats pa
       LEFT JOIN produits p ON pa.produit_id = p.id
       LEFT JOIN boutiques b ON pa.boutique_id = b.id
       WHERE pa.partenaire_id = ?
       ORDER BY pa.date_achat DESC, pa.id DESC
       LIMIT 50`,
      [req.params.id]
    );

    // Top produits fournis
    const topProduits = await query(
      `SELECT
        p.id, p.name, p.reference,
        COUNT(pa.id) AS nb_achats,
        SUM(pa.quantite) AS quantite_totale,
        SUM(pa.total) AS total_achats
       FROM partenaire_achats pa
       JOIN produits p ON pa.produit_id = p.id
       WHERE pa.partenaire_id = ?
       GROUP BY p.id
       ORDER BY total_achats DESC
       LIMIT 10`,
      [req.params.id]
    );

    res.json({
      success: true,
      partenaire,
      stats,
      achats,
      top_produits: topProduits,
    });
  })
);

// ═══════════════════════════════════════════════
// POST /api/partenaires — créer (admin)
// ═══════════════════════════════════════════════
router.post(
  '/',
  requireAdmin,
  validate([
    body('name').trim().isLength({ min: 2, max: 150 }).withMessage('Nom requis'),
    body('phone').trim().matches(/^\d{8}$/).withMessage('Téléphone 8 chiffres requis'),
    body('phone_secondary').optional({ values: 'falsy' }).trim().matches(/^\d{8}$/),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('payment_terms').optional({ values: 'falsy' }).isIn(PAYMENT_TERMS),
    body('category').optional({ values: 'falsy' }).isIn(CATEGORIES),
    body('rating').optional({ values: 'falsy' }).isInt({ min: 1, max: 5 }).toInt(),
    body('credit_limit').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('discount_rate').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }).toFloat(),
  ]),
  asyncHandler(async (req, res) => {
    const {
      code, name, company_name, contact_name, phone, phone_secondary,
      email, address, city, province, country, tax_id, registration_number,
      payment_terms, credit_limit, discount_rate, category, notes, rating,
    } = req.body;

    // Vérifier le téléphone
    const existing = await get('SELECT id FROM partenaires WHERE phone = ?', [phone]);
    if (existing) throw new AppError('Ce téléphone est déjà utilisé', 409, 'PHONE_EXISTS');

    // Générer un code si absent
    let finalCode = code?.trim();
    if (!finalCode) {
      finalCode = generateCode();
      // S'assurer de l'unicité
      let dup = await get('SELECT id FROM partenaires WHERE code = ?', [finalCode]);
      let attempts = 0;
      while (dup && attempts < 10) {
        finalCode = generateCode();
        dup = await get('SELECT id FROM partenaires WHERE code = ?', [finalCode]);
        attempts++;
      }
    } else {
      const dup = await get('SELECT id FROM partenaires WHERE code = ?', [finalCode]);
      if (dup) throw new AppError('Ce code existe déjà', 409, 'CODE_EXISTS');
    }

    const result = await run(
      `INSERT INTO partenaires
       (code, name, company_name, contact_name, phone, phone_secondary,
        email, address, city, province, country, tax_id, registration_number,
        payment_terms, credit_limit, discount_rate, category, notes, rating, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalCode, name.trim(), company_name || null, contact_name || null,
        phone, phone_secondary || null, email || null, address || null,
        city || null, province || null, country || 'Tchad',
        tax_id || null, registration_number || null,
        payment_terms || 'comptant', credit_limit || 0, discount_rate || 0,
        category || 'autre', notes || null, rating || 5, req.user.userId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PARTENAIRE_CREATED',
      resource: 'partenaires',
      resourceId: result.lastID,
      details: { name, phone },
      ip: getClientIp(req),
    });

    const partenaire = await get('SELECT * FROM partenaires WHERE id = ?', [result.lastID]);

    res.status(201).json({
      success: true,
      message: 'Partenaire créé',
      partenaire,
    });
  })
);

// ═══════════════════════════════════════════════
// PUT /api/partenaires/:id — modifier (admin)
// ═══════════════════════════════════════════════
router.put(
  '/:id',
  requireAdmin,
  validate([
    param('id').isInt().toInt(),
    body('name').optional({ values: 'falsy' }).trim().isLength({ min: 2, max: 150 }),
    body('phone').optional({ values: 'falsy' }).trim().matches(/^\d{8}$/),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('payment_terms').optional({ values: 'falsy' }).isIn(PAYMENT_TERMS),
    body('category').optional({ values: 'falsy' }).isIn(CATEGORIES),
    body('rating').optional({ values: 'falsy' }).isInt({ min: 1, max: 5 }).toInt(),
    body('is_active').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const partenaire = await get('SELECT * FROM partenaires WHERE id = ?', [req.params.id]);
    if (!partenaire) throw new AppError('Partenaire introuvable', 404, 'PARTENAIRE_NOT_FOUND');

    const {
      name, company_name, contact_name, phone, phone_secondary,
      email, address, city, province, country, tax_id, registration_number,
      payment_terms, credit_limit, discount_rate, category, notes, rating, is_active,
    } = req.body;

    // Vérif téléphone si changé
    if (phone && phone !== partenaire.phone) {
      const dup = await get('SELECT id FROM partenaires WHERE phone = ? AND id != ?', [phone, req.params.id]);
      if (dup) throw new AppError('Ce téléphone est déjà utilisé', 409, 'PHONE_EXISTS');
    }

    await run(
      `UPDATE partenaires SET
        name = COALESCE(?, name),
        company_name = COALESCE(?, company_name),
        contact_name = COALESCE(?, contact_name),
        phone = COALESCE(?, phone),
        phone_secondary = COALESCE(?, phone_secondary),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        province = COALESCE(?, province),
        country = COALESCE(?, country),
        tax_id = COALESCE(?, tax_id),
        registration_number = COALESCE(?, registration_number),
        payment_terms = COALESCE(?, payment_terms),
        credit_limit = COALESCE(?, credit_limit),
        discount_rate = COALESCE(?, discount_rate),
        category = COALESCE(?, category),
        notes = COALESCE(?, notes),
        rating = COALESCE(?, rating),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        name, company_name, contact_name, phone, phone_secondary,
        email, address, city, province, country, tax_id, registration_number,
        payment_terms, credit_limit, discount_rate, category, notes, rating,
        is_active === undefined ? partenaire.is_active : (is_active ? 1 : 0),
        req.params.id,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PARTENAIRE_UPDATED',
      resource: 'partenaires',
      resourceId: req.params.id,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM partenaires WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Partenaire mis à jour', partenaire: updated });
  })
);

// ═══════════════════════════════════════════════
// DELETE /api/partenaires/:id — désactiver (admin)
// ═══════════════════════════════════════════════
router.delete(
  '/:id',
  requireAdmin,
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const partenaire = await get('SELECT * FROM partenaires WHERE id = ?', [req.params.id]);
    if (!partenaire) throw new AppError('Partenaire introuvable', 404, 'PARTENAIRE_NOT_FOUND');

    await run(
      'UPDATE partenaires SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [req.params.id]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PARTENAIRE_DEACTIVATED',
      resource: 'partenaires',
      resourceId: req.params.id,
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Partenaire désactivé' });
  })
);

// ═══════════════════════════════════════════════
// POST /api/partenaires/:id/achats — créer un achat
// ═══════════════════════════════════════════════
router.post(
  '/:id/achats',
  requireGerantOrAdmin,
  validate([
    param('id').isInt().toInt(),
    body('produit_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('quantite').isInt({ min: 1 }).toInt().withMessage('Quantité ≥ 1'),
    body('prix_unitaire').isInt({ min: 0 }).toInt().withMessage('Prix ≥ 0'),
    body('date_achat').optional({ values: 'falsy' }).isISO8601(),
    body('moyen_paiement').optional({ values: 'falsy' }).isIn(['especes', 'mobile_money', 'virement', 'cheque', 'carte', 'alkherpay', 'credit']),
    body('statut_paiement').optional({ values: 'falsy' }).isIn(['paye', 'partiel', 'impaye']),
    body('montant_paye').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const partenaire = await get('SELECT * FROM partenaires WHERE id = ?', [req.params.id]);
    if (!partenaire) throw new AppError('Partenaire introuvable', 404, 'PARTENAIRE_NOT_FOUND');

    const {
      produit_id, boutique_id, quantite, prix_unitaire,
      date_achat, moyen_paiement, statut_paiement, montant_paye, notes,
    } = req.body;

    const total = quantite * prix_unitaire;
    const reference = `ACH-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

    const result = await run(
      `INSERT INTO partenaire_achats
       (reference, partenaire_id, produit_id, boutique_id, quantite, prix_unitaire, total,
        date_achat, moyen_paiement, statut_paiement, montant_paye, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reference, req.params.id, produit_id || null, boutique_id || null,
        quantite, prix_unitaire, total,
        date_achat || new Date().toISOString().slice(0, 10),
        moyen_paiement || 'comptant',
        statut_paiement || 'paye',
        montant_paye || (statut_paiement === 'paye' ? total : 0),
        notes || null,
        req.user.userId,
      ]
    );

    res.status(201).json({
      success: true,
      message: `Achat ${reference} créé`,
      achat: { id: result.lastID, reference, total },
    });
  })
);

module.exports = router;