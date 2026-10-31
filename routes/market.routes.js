// backend/routes/market.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { get, run, query, transaction } = require('../database/db');
const { optionalAuth, authenticateToken } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { calcCommandeMargin } = require('../services/marginCalculator');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
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

async function loadImagesFor(produitIds) {
  if (!produitIds || produitIds.length === 0) return {};
  const placeholders = produitIds.map(() => '?').join(',');
  const images = await query(
    `SELECT id, produit_id, file_path, is_primary, order_index
     FROM produit_images
     WHERE produit_id IN (${placeholders})
     ORDER BY is_primary DESC, order_index ASC`,
    produitIds
  );
  const byProduit = {};
  images.forEach((img) => {
    if (!byProduit[img.produit_id]) byProduit[img.produit_id] = [];
    byProduit[img.produit_id].push(img);
  });
  return byProduit;
}

// ═══════════════════════════════════════════════
// ROUTES PUBLIQUES (sans auth obligatoire)
// ═══════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /api/market/produits — catalogue public
// ─────────────────────────────────────────────
router.get(
  '/produits',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('sort').optional({ values: 'falsy' }).isIn(['name', 'prix_vente', 'created_at', 'stock']),
    qv('order').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
    qv('in_stock').optional({ values: 'falsy' }).isIn(['0', '1']),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const search = cleanStr(req.query.search);
    const categoryId = cleanId(req.query.category_id);
    const boutiqueId = cleanId(req.query.boutique_id);
    const sort = req.query.sort || 'created_at';
    const order = (req.query.order || 'desc').toUpperCase();
    const inStock = req.query.in_stock;

    const conditions = ['p.is_active = 1', 'b.is_active = 1'];
    const params = [];

    if (categoryId) { conditions.push('p.category_id = ?'); params.push(categoryId); }
    if (boutiqueId) { conditions.push('p.boutique_id = ?'); params.push(boutiqueId); }
    if (search) {
      conditions.push('(p.name LIKE ? OR p.reference LIKE ? OR p.description LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (inStock === '1') {
      conditions.push('p.stock > 0');
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM produits p
       JOIN boutiques b ON p.boutique_id = b.id
       WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT p.id, p.reference, p.name, p.description,
              p.prix_vente, p.stock, p.seuil_alerte,
              p.category_id, p.boutique_id, p.created_at,
              c.name AS category_name, c.color AS category_color,
              b.name AS boutique_name,
              CASE WHEN p.stock <= p.seuil_alerte THEN 1 ELSE 0 END AS alerte_stock
       FROM produits p
       JOIN categories c ON p.category_id = c.id
       JOIN boutiques b ON p.boutique_id = b.id
       WHERE ${where}
       ORDER BY p.${sort} ${order}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const imagesByProduit = await loadImagesFor(rows.map((r) => r.id));
    rows.forEach((r) => {
      r.images = imagesByProduit[r.id] || [];
      r.image_principale = r.images[0]?.file_path || null;
    });

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

// ─────────────────────────────────────────────
// GET /api/market/produits/:id — détail public
// ─────────────────────────────────────────────
router.get(
  '/produits/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const produit = await get(
      `SELECT p.id, p.reference, p.name, p.description,
              p.prix_vente, p.stock, p.seuil_alerte,
              p.category_id, p.boutique_id, p.created_at,
              c.name AS category_name, c.color AS category_color,
              b.name AS boutique_name, b.address AS boutique_address,
              b.phone AS boutique_phone
       FROM produits p
       JOIN categories c ON p.category_id = c.id
       JOIN boutiques b ON p.boutique_id = b.id
       WHERE p.id = ? AND p.is_active = 1 AND b.is_active = 1`,
      [req.params.id]
    );
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const images = await query(
      `SELECT id, file_path, is_primary, order_index
       FROM produit_images
       WHERE produit_id = ?
       ORDER BY is_primary DESC, order_index ASC`,
      [req.params.id]
    );

    res.json({
      success: true,
      produit: {
        ...produit,
        images,
        image_principale: images[0]?.file_path || null,
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/market/categories — catégories actives
// ─────────────────────────────────────────────
router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT DISTINCT c.id, c.name, c.color, c.description,
              (SELECT COUNT(*) FROM produits p
               JOIN boutiques b ON p.boutique_id = b.id
               WHERE p.category_id = c.id AND p.is_active = 1 AND b.is_active = 1) AS nb_produits
       FROM categories c
       WHERE c.is_active = 1
       ORDER BY c.name ASC`
    );
    res.json({ success: true, data: rows });
  })
);

// ─────────────────────────────────────────────
// GET /api/market/boutiques — boutiques actives
// ─────────────────────────────────────────────
router.get(
  '/boutiques',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT b.id, b.name, b.address, b.phone,
              c.name AS category_name, c.color AS category_color,
              (SELECT COUNT(*) FROM produits p
               WHERE p.boutique_id = b.id AND p.is_active = 1) AS nb_produits
       FROM boutiques b
       JOIN categories c ON b.category_id = c.id
       WHERE b.is_active = 1
       ORDER BY b.name ASC`
    );
    res.json({ success: true, data: rows });
  })
);

// ─────────────────────────────────────────────
// GET /api/market/stats — stats globales (accueil)
// ─────────────────────────────────────────────
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const stats = await get(
      `SELECT
        (SELECT COUNT(*) FROM produits p JOIN boutiques b ON p.boutique_id = b.id
         WHERE p.is_active = 1 AND b.is_active = 1) AS nb_produits,
        (SELECT COUNT(*) FROM categories WHERE is_active = 1) AS nb_categories,
        (SELECT COUNT(*) FROM boutiques WHERE is_active = 1) AS nb_boutiques`
    );
    res.json({ success: true, stats });
  })
);

// ═══════════════════════════════════════════════
// ROUTE PROTÉGÉE : COMMANDER
// ═══════════════════════════════════════════════

// ─────────────────────────────────────────────
// POST /api/market/commander
// Permet à un user authentifié de commander un produit
// ─────────────────────────────────────────────
router.post(
  '/commander',
  authenticateToken,
  validate([
    body('produit_id').isInt().toInt().withMessage('Produit requis'),
    body('quantite').isInt({ min: 1 }).toInt().withMessage('Quantité ≥ 1'),
    body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { produit_id, quantite, notes } = req.body;

    // Charger le produit
    const produit = await get(
      `SELECT p.*, b.name AS boutique_name, b.id AS boutique_id
       FROM produits p
       JOIN boutiques b ON p.boutique_id = b.id
       WHERE p.id = ? AND p.is_active = 1 AND b.is_active = 1`,
      [produit_id]
    );
    if (!produit) throw new AppError('Produit introuvable ou indisponible', 404, 'PRODUIT_NOT_FOUND');

    if (produit.stock < quantite) {
      throw new AppError(
        `Stock insuffisant. Disponible : ${produit.stock}`,
        400,
        'INSUFFICIENT_STOCK'
      );
    }

    // Vérifier que l'utilisateur n'est pas l'agent propriétaire
    if (req.user.role === 'agent') {
      // Optionnel : on peut interdire à un agent de commander ses propres produits
      const own = await get(
        `SELECT 1 FROM lignes_commande lc
         JOIN commandes c ON lc.commande_id = c.id
         WHERE lc.produit_id = ? AND c.agent_id = ? AND c.statut = 'en_attente' LIMIT 1`,
        [produit_id, userId]
      );
      if (own) {
        throw new AppError(
          'Vous avez déjà une commande en attente sur ce produit',
          400,
          'DUPLICATE_ORDER'
        );
      }
    }

    // Calcul des totaux (snapshot des prix)
    const lignesCalc = [{
      quantite,
      prix_partenaire_applique: produit.prix_partenaire,
      prix_vente_applique: produit.prix_vente,
    }];
    const totals = calcCommandeMargin(lignesCalc);

    const reference = `CMD-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

    // Transaction : créer la commande + la ligne
    const commandeId = await transaction(async (db) => {
      const cmdRes = await db.run(
        `INSERT INTO commandes
         (reference, agent_id, boutique_id, statut, total_partenaire, total_vente)
         VALUES (?, ?, ?, 'en_attente', ?, ?)`,
        [reference, userId, produit.boutique_id, totals.total_partenaire, totals.total_vente]
      );

      const newCmdId = cmdRes.lastID;

      await db.run(
        `INSERT INTO lignes_commande
         (commande_id, produit_id, quantite, prix_partenaire_applique, prix_vente_applique)
         VALUES (?, ?, ?, ?, ?)`,
        [newCmdId, produit_id, quantite, produit.prix_partenaire, produit.prix_vente]
      );

      return newCmdId;
    });

    // Notification au gérant
    const gerants = await query(
      `SELECT DISTINCT gerant_id FROM boutiques
       WHERE id = ? AND gerant_id IS NOT NULL`,
      [produit.boutique_id]
    );
    for (const g of gerants) {
      if (g.gerant_id) {
        await run(
          `INSERT INTO notifications (user_id, title, message, type, category, link)
           VALUES (?, '🛒 Nouvelle commande market', ?, 'info', 'commande', ?)`,
          [
            g.gerant_id,
            `${req.user.fullname || 'Un client'} a commandé ${quantite}x "${produit.name}"`,
            `/commandes/${commandeId}`,
          ]
        );
      }
    }

    // Notification au client
    await run(
      `INSERT INTO notifications (user_id, title, message, type, category, link)
       VALUES (?, '✅ Commande enregistrée', ?, 'success', 'commande', ?)`,
      [
        userId,
        `Votre commande ${reference} est en attente de validation`,
        `/commandes/${commandeId}`,
      ]
    );

    const commande = await get('SELECT * FROM commandes WHERE id = ?', [commandeId]);

    res.status(201).json({
      success: true,
      message: `Commande ${reference} enregistrée (en attente de validation)`,
      commande,
      marge_estimee: totals.total_marge,
    });
  })
);

module.exports = router;