// backend/routes/produits.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const {
  requirePermission,
  canAccessBoutique,
  getAccessibleBoutiques,
} = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');
const { calcUnitMargin } = require('../services/marginCalculator');
const { uploadProduit } = require('../middlewares/upload');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function generateSKU(categoryName = 'PRD') {
  const prefix = categoryName.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${uuidv4().slice(0, 4).toUpperCase()}`;
}

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

// ─────────────────────────────────────────────
// GET /api/produits — liste paginée + filtres
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    qv('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 1000 }).toInt(),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('is_active').optional({ values: 'falsy' }).isIn(['0', '1', 'all']),
    qv('low_stock').optional({ values: 'falsy' }).isIn(['0', '1']),
    qv('sort').optional({ values: 'falsy' }).isIn(['name', 'prix_vente', 'stock', 'marge_unitaire', 'created_at']),
    qv('order').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
  ]),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const search = cleanStr(req.query.search);
    const categoryId = cleanId(req.query.category_id);
    const boutiqueId = cleanId(req.query.boutique_id);
    const isActive = req.query.is_active;
    const lowStock = req.query.low_stock;
    const sort = req.query.sort || 'name';
    const order = (req.query.order || 'asc').toUpperCase();

    let allowedIds = null;
    if (req.user.role !== 'admin') {
      const accessible = await getAccessibleBoutiques(req.user);
      allowedIds = accessible.map((b) => b.id);
      if (allowedIds.length === 0) {
        return res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
    }

    const conditions = ['1=1'];
    const params = [];

    if (allowedIds) {
      conditions.push(`p.boutique_id IN (${allowedIds.map(() => '?').join(',')})`);
      params.push(...allowedIds);
    }
    if (categoryId) { conditions.push('p.category_id = ?'); params.push(categoryId); }
    if (boutiqueId) { conditions.push('p.boutique_id = ?'); params.push(boutiqueId); }
    if (search) {
      conditions.push('(p.name LIKE ? OR p.reference LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (isActive && isActive !== 'all') {
      conditions.push('p.is_active = ?');
      params.push(parseInt(isActive, 10));
    }
    if (lowStock === '1') {
      conditions.push('p.stock <= p.seuil_alerte');
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(`SELECT COUNT(*) AS total FROM produits p WHERE ${where}`, params);

    const rows = await query(
      `SELECT p.*,
              c.name AS category_name,
              c.color AS category_color,
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
        page,
        limit,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / limit),
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /api/produits/alertes/stock-bas
// ⚠️ AVANT /:id
// ─────────────────────────────────────────────
router.get(
  '/alertes/stock-bas',
  asyncHandler(async (req, res) => {
    let allowedIds = null;
    if (req.user.role !== 'admin') {
      const acc = await getAccessibleBoutiques(req.user);
      allowedIds = acc.map((b) => b.id);
      if (allowedIds.length === 0) return res.json({ success: true, data: [], count: 0 });
    }

    let sql = `SELECT p.id, p.reference, p.name, p.stock, p.seuil_alerte,
                      b.name AS boutique_name, c.name AS category_name
               FROM produits p
               JOIN boutiques b ON p.boutique_id = b.id
               JOIN categories c ON p.category_id = c.id
               WHERE p.is_active = 1 AND p.stock <= p.seuil_alerte`;
    const params = [];
    if (allowedIds) {
      sql += ` AND p.boutique_id IN (${allowedIds.map(() => '?').join(',')})`;
      params.push(...allowedIds);
    }
    sql += ' ORDER BY p.stock ASC';

    const rows = await query(sql, params);
    res.json({ success: true, data: rows, count: rows.length });
  })
);

// ─────────────────────────────────────────────
// GET /api/produits/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const produit = await get(
      `SELECT p.*, c.name AS category_name, b.name AS boutique_name
       FROM produits p
       JOIN categories c ON p.category_id = c.id
       JOIN boutiques b ON p.boutique_id = b.id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, produit.boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'PRODUIT_FORBIDDEN');

    const ventesRecentes = await query(
      `SELECT lc.quantite, lc.prix_vente_applique, lc.marge_calculee,
              cmd.reference AS commande_ref, v.reference AS vente_ref,
              v.created_at AS date_vente, u.fullname AS agent_name
       FROM lignes_commande lc
       JOIN commandes cmd ON lc.commande_id = cmd.id
       JOIN ventes v ON v.commande_id = cmd.id
       JOIN users u ON v.agent_id = u.id
       WHERE lc.produit_id = ? AND v.statut = 'validee'
       ORDER BY v.created_at DESC
       LIMIT 10`,
      [req.params.id]
    );

    const stats = await get(
      `SELECT
         COALESCE(SUM(lc.quantite), 0) AS quantite_totale_vendue,
         COALESCE(SUM(lc.marge_calculee), 0) AS marge_totale,
         COALESCE(SUM(lc.prix_vente_applique * lc.quantite), 0) AS ca_total
       FROM lignes_commande lc
       JOIN commandes cmd ON lc.commande_id = cmd.id
       WHERE lc.produit_id = ? AND cmd.statut IN ('validee','livree')`,
      [req.params.id]
    );

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
        ventes_recentes: ventesRecentes,
        stats,
      },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/produits — création avec images
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('produits', 'create'),
  uploadProduit.array('images', 10),
  validate([
    body('name').trim().isLength({ min: 2, max: 150 }).withMessage('Nom requis (2-150 car.)'),
    body('reference').optional({ values: 'falsy' }).trim().isLength({ max: 50 }),
    body('description').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
    body('category_id').isInt().toInt().withMessage('Catégorie requise'),
    body('boutique_id').isInt().toInt().withMessage('Boutique requise'),
    body('prix_partenaire').isInt({ min: 0 }).toInt().withMessage('Prix partenaire requis'),
    body('prix_vente').isInt({ min: 0 }).toInt().withMessage('Prix de vente requis'),
    body('stock').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('seuil_alerte').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const {
      name, reference, description,
      category_id, boutique_id,
      prix_partenaire, prix_vente,
      stock, seuil_alerte,
    } = req.body;

    let marge;
    try {
      marge = calcUnitMargin(prix_partenaire, prix_vente);
    } catch (err) {
      throw new AppError(err.message, 400, err.code || 'INVALID_PRICES');
    }

    const category = await get('SELECT id, name FROM categories WHERE id = ? AND is_active = 1', [category_id]);
    if (!category) throw new AppError('Catégorie introuvable ou inactive', 404, 'CATEGORY_NOT_FOUND');

    const boutique = await get('SELECT id FROM boutiques WHERE id = ? AND is_active = 1', [boutique_id]);
    if (!boutique) throw new AppError('Boutique introuvable ou inactive', 404, 'BOUTIQUE_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé à cette boutique', 403, 'BOUTIQUE_FORBIDDEN');

    let finalRef = reference?.trim();
    if (!finalRef) finalRef = generateSKU(category.name);

    const dupRef = await get('SELECT id FROM produits WHERE reference = ?', [finalRef]);
    if (dupRef) throw new AppError('Cette référence produit existe déjà', 409, 'REFERENCE_EXISTS');

    const result = await run(
      `INSERT INTO produits
       (reference, name, description, category_id, boutique_id,
        prix_partenaire, prix_vente, stock, seuil_alerte)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalRef, name.trim(), description || null,
        category_id, boutique_id,
        prix_partenaire, prix_vente,
        stock || 0, seuil_alerte ?? 10,
      ]
    );

    const produitId = result.lastID;

    const files = req.files || [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      await run(
        `INSERT INTO produit_images
         (produit_id, filename, file_path, file_size, mime_type, is_primary, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          produitId,
          f.filename,
          f.path.replace(/\\/g, '/'),
          f.size,
          f.mimetype,
          i === 0 ? 1 : 0,
          i,
        ]
      );
    }

    const produit = await get('SELECT * FROM produits WHERE id = ?', [produitId]);
    const images = await query(
      'SELECT id, file_path, is_primary, order_index FROM produit_images WHERE produit_id = ? ORDER BY order_index',
      [produitId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PRODUIT_CREATED',
      resource: 'produits',
      resourceId: produitId,
      details: { name, prix_partenaire, prix_vente, marge, nb_images: files.length },
      ip: getClientIp(req),
    });

    res.status(201).json({
      success: true,
      message: `Produit créé avec ${files.length} image(s) (marge : ${marge.toLocaleString()} FCFA)`,
      produit: { ...produit, images, image_principale: images[0]?.file_path || null },
      marge_unitaire: marge,
    });
  })
);

// ─────────────────────────────────────────────
// PUT /api/produits/:id — mise à jour
// ─────────────────────────────────────────────
router.put(
  '/:id',
  requirePermission('produits', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('name').optional({ values: 'falsy' }).trim().isLength({ min: 2, max: 150 }),
    body('description').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
    body('category_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    body('prix_partenaire').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('prix_vente').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('stock').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('seuil_alerte').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('is_active').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const produit = await get('SELECT * FROM produits WHERE id = ?', [targetId]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, produit.boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'PRODUIT_FORBIDDEN');

    if (req.user.role === 'gerant') {
      if (req.body.prix_partenaire !== undefined || req.body.prix_vente !== undefined) {
        throw new AppError('Seul un administrateur peut modifier les prix', 403, 'GERANT_CANNOT_EDIT_PRICES');
      }
    }

    const nextPP = req.body.prix_partenaire ?? produit.prix_partenaire;
    const nextPV = req.body.prix_vente ?? produit.prix_vente;

    try {
      calcUnitMargin(nextPP, nextPV);
    } catch (err) {
      throw new AppError(err.message, 400, err.code || 'INVALID_PRICES');
    }

    if (req.body.category_id !== undefined) {
      const c = await get('SELECT id FROM categories WHERE id = ? AND is_active = 1', [req.body.category_id]);
      if (!c) throw new AppError('Catégorie introuvable', 404, 'CATEGORY_NOT_FOUND');
    }
    if (req.body.boutique_id !== undefined && req.body.boutique_id !== produit.boutique_id) {
      const b = await get('SELECT id FROM boutiques WHERE id = ? AND is_active = 1', [req.body.boutique_id]);
      if (!b) throw new AppError('Boutique introuvable', 404, 'BOUTIQUE_NOT_FOUND');
      if (req.user.role !== 'admin') {
        throw new AppError('Seul un admin peut déplacer un produit', 403, 'CANNOT_MOVE_PRODUIT');
      }
    }

    await run(
      `UPDATE produits SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        category_id = COALESCE(?, category_id),
        boutique_id = COALESCE(?, boutique_id),
        prix_partenaire = COALESCE(?, prix_partenaire),
        prix_vente = COALESCE(?, prix_vente),
        stock = COALESCE(?, stock),
        seuil_alerte = COALESCE(?, seuil_alerte),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        req.body.name, req.body.description,
        req.body.category_id, req.body.boutique_id,
        req.body.prix_partenaire, req.body.prix_vente,
        req.body.stock, req.body.seuil_alerte,
        req.body.is_active === undefined ? produit.is_active : (req.body.is_active ? 1 : 0),
        targetId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PRODUIT_UPDATED',
      resource: 'produits',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM produits WHERE id = ?', [targetId]);
    const images = await query(
      'SELECT id, file_path, is_primary, order_index FROM produit_images WHERE produit_id = ? ORDER BY order_index',
      [targetId]
    );
    res.json({
      success: true,
      message: 'Produit mis à jour',
      produit: { ...updated, images, image_principale: images[0]?.file_path || null },
    });
  })
);

// ═══════════════════════════════════════════════
// IMAGES PRODUIT
// ═══════════════════════════════════════════════

// ─────────────────────────────────────────────
// POST /api/produits/:id/images — ajouter des images
// ─────────────────────────────────────────────
router.post(
  '/:id/images',
  requirePermission('produits', 'update'),
  uploadProduit.array('images', 10),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const produitId = req.params.id;

    const produit = await get('SELECT * FROM produits WHERE id = ?', [produitId]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, produit.boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'PRODUIT_FORBIDDEN');

    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('Aucune image fournie', 400, 'NO_FILES');
    }

    const existing = await get(
      'SELECT COUNT(*) AS c FROM produit_images WHERE produit_id = ?',
      [produitId]
    );
    const startOrder = existing.c;

    const insertedIds = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = await run(
        `INSERT INTO produit_images
         (produit_id, filename, file_path, file_size, mime_type, is_primary, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          produitId,
          f.filename,
          f.path.replace(/\\/g, '/'),
          f.size,
          f.mimetype,
          startOrder === 0 && i === 0 ? 1 : 0,
          startOrder + i,
        ]
      );
      insertedIds.push(r.lastID);
    }

    const images = await query(
      'SELECT id, file_path, is_primary, order_index FROM produit_images WHERE produit_id = ? ORDER BY order_index',
      [produitId]
    );

    await logAction({
      userId: req.user.userId,
      action: 'PRODUIT_IMAGES_ADDED',
      resource: 'produits',
      resourceId: produitId,
      details: { nb_images: files.length },
      ip: getClientIp(req),
    });

    res.json({
      success: true,
      message: `${files.length} image(s) ajoutée(s)`,
      images,
      inserted_ids: insertedIds,
    });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/produits/:id/images/:imageId
// ─────────────────────────────────────────────
router.delete(
  '/:id/images/:imageId',
  requirePermission('produits', 'update'),
  validate([
    param('id').isInt().toInt(),
    param('imageId').isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const produitId = req.params.id;
    const imageId = req.params.imageId;

    const produit = await get('SELECT * FROM produits WHERE id = ?', [produitId]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, produit.boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'PRODUIT_FORBIDDEN');

    const image = await get(
      'SELECT * FROM produit_images WHERE id = ? AND produit_id = ?',
      [imageId, produitId]
    );
    if (!image) throw new AppError('Image introuvable', 404, 'IMAGE_NOT_FOUND');

    try {
      const absolute = path.isAbsolute(image.file_path)
        ? image.file_path
        : path.join(__dirname, '..', image.file_path);
      if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    } catch (e) {
      console.warn('⚠️ Fichier non supprimé :', e.message);
    }

    await run('DELETE FROM produit_images WHERE id = ?', [imageId]);

    if (image.is_primary === 1) {
      const next = await get(
        'SELECT id FROM produit_images WHERE produit_id = ? ORDER BY order_index LIMIT 1',
        [produitId]
      );
      if (next) {
        await run('UPDATE produit_images SET is_primary = 1 WHERE id = ?', [next.id]);
      }
    }

    await logAction({
      userId: req.user.userId,
      action: 'PRODUIT_IMAGE_DELETED',
      resource: 'produits',
      resourceId: produitId,
      details: { imageId },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Image supprimée' });
  })
);

// ─────────────────────────────────────────────
// PATCH /api/produits/:id/images/:imageId/primary
// ─────────────────────────────────────────────
router.patch(
  '/:id/images/:imageId/primary',
  requirePermission('produits', 'update'),
  validate([
    param('id').isInt().toInt(),
    param('imageId').isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const produitId = req.params.id;
    const imageId = req.params.imageId;

    const produit = await get('SELECT * FROM produits WHERE id = ?', [produitId]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, produit.boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'PRODUIT_FORBIDDEN');

    const image = await get(
      'SELECT * FROM produit_images WHERE id = ? AND produit_id = ?',
      [imageId, produitId]
    );
    if (!image) throw new AppError('Image introuvable', 404, 'IMAGE_NOT_FOUND');

    await run('UPDATE produit_images SET is_primary = 0 WHERE produit_id = ?', [produitId]);
    await run('UPDATE produit_images SET is_primary = 1 WHERE id = ?', [imageId]);

    res.json({ success: true, message: 'Image définie comme principale' });
  })
);

// ─────────────────────────────────────────────
// PATCH /api/produits/:id/stock
// ─────────────────────────────────────────────
router.patch(
  '/:id/stock',
  requirePermission('produits', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('new_stock').isInt({ min: 0 }).toInt().withMessage('Stock entier ≥ 0 requis'),
    body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { new_stock, reason } = req.body;

    const produit = await get('SELECT * FROM produits WHERE id = ?', [targetId]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const canAccess = await canAccessBoutique(req.user, produit.boutique_id);
    if (!canAccess) throw new AppError('Accès non autorisé', 403, 'PRODUIT_FORBIDDEN');

    const delta = new_stock - produit.stock;

    await run('UPDATE produits SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [new_stock, targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'PRODUIT_STOCK_ADJUSTED',
      resource: 'produits',
      resourceId: targetId,
      details: { before: produit.stock, after: new_stock, delta, reason },
      ip: getClientIp(req),
    });

    res.json({
      success: true,
      message: `Stock ajusté : ${produit.stock} → ${new_stock} (${delta >= 0 ? '+' : ''}${delta})`,
      stock: new_stock,
      delta,
    });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/produits/:id — soft delete
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('produits', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const produit = await get('SELECT * FROM produits WHERE id = ?', [targetId]);
    if (!produit) throw new AppError('Produit introuvable', 404, 'PRODUIT_NOT_FOUND');

    const pending = await get(
      `SELECT COUNT(*) AS c FROM lignes_commande lc
       JOIN commandes cmd ON lc.commande_id = cmd.id
       WHERE lc.produit_id = ? AND cmd.statut = 'en_attente'`,
      [targetId]
    );
    if (pending.c > 0) {
      throw new AppError(`Impossible : ${pending.c} ligne(s) de commande en attente`, 409, 'PRODUIT_IN_USE');
    }

    await run('UPDATE produits SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'PRODUIT_DELETED',
      resource: 'produits',
      resourceId: targetId,
      details: { name: produit.name },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Produit désactivé' });
  })
);

module.exports = router;