// backend/routes/categories.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');

// Toutes les routes : authentification requise
router.use(authenticateToken);

// ─────────────────────────────────────────────
// GET /api/categories
// Liste des catégories (accessible à tous les rôles)
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('search').optional().trim().isLength({ max: 100 }),
    qv('parent_id').optional().isInt().toInt(),
    qv('tree').optional().isIn(['0', '1']),
    qv('is_active').optional().isIn(['0', '1', 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const conditions = ['1=1'];
    const params = [];

    if (req.query.search) {
      conditions.push('name LIKE ?');
      params.push(`%${req.query.search}%`);
    }
    if (req.query.parent_id !== undefined) {
      conditions.push('parent_id = ?');
      params.push(req.query.parent_id);
    }
    if (req.query.is_active && req.query.is_active !== 'all') {
      conditions.push('is_active = ?');
      params.push(parseInt(req.query.is_active, 10));
    }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM boutiques WHERE category_id = c.id AND is_active = 1) AS nb_boutiques,
              (SELECT COUNT(*) FROM produits   WHERE category_id = c.id AND is_active = 1) AS nb_produits
       FROM categories c
       WHERE ${where}
       ORDER BY c.order_index ASC, c.name ASC`,
      params
    );

    // Si tree=1, construire une arborescence
    if (req.query.tree === '1') {
      const byId = new Map();
      rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
      const roots = [];
      for (const r of byId.values()) {
        if (r.parent_id && byId.has(r.parent_id)) {
          byId.get(r.parent_id).children.push(r);
        } else {
          roots.push(r);
        }
      }
      return res.json({ success: true, data: roots, flat: rows });
    }

    res.json({ success: true, data: rows });
  })
);

// ─────────────────────────────────────────────
// GET /api/categories/:id
// ─────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const category = await get(
      `SELECT * FROM categories WHERE id = ?`,
      [req.params.id]
    );
    if (!category) throw new AppError('Catégorie introuvable', 404, 'CATEGORY_NOT_FOUND');

    const children = await query(
      'SELECT id, name FROM categories WHERE parent_id = ? ORDER BY name',
      [req.params.id]
    );
    const boutiques = await query(
      'SELECT id, name FROM boutiques WHERE category_id = ? AND is_active = 1 ORDER BY name',
      [req.params.id]
    );

    res.json({
      success: true,
      category: { ...category, children, boutiques },
    });
  })
);

// ─────────────────────────────────────────────
// POST /api/categories — admin uniquement
// ─────────────────────────────────────────────
router.post(
  '/',
  requirePermission('categories', 'create'),
  validate([
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nom requis (2-100 car.)'),
    body('description').optional().trim().isLength({ max: 500 }),
    body('color').optional().matches(/^#[0-9a-fA-F]{6}$/).withMessage('Couleur hex invalide'),
    body('parent_id').optional({ nullable: true }).isInt().toInt(),
    body('order_index').optional().isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const { name, description, color, parent_id, order_index } = req.body;

    // Vérifier l'unicité du nom
    const existing = await get('SELECT id FROM categories WHERE name = ?', [name]);
    if (existing) throw new AppError('Cette catégorie existe déjà', 409, 'CATEGORY_NAME_EXISTS');

    // Vérifier parent_id si fourni
    if (parent_id) {
      const parent = await get('SELECT id FROM categories WHERE id = ?', [parent_id]);
      if (!parent) throw new AppError('Catégorie parente introuvable', 404, 'PARENT_NOT_FOUND');
    }

    const result = await run(
      `INSERT INTO categories (name, description, color, parent_id, order_index)
       VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), description || null, color || '#1e3a5f', parent_id || null, order_index || 0]
    );

    const category = await get('SELECT * FROM categories WHERE id = ?', [result.lastID]);

    await logAction({
      userId: req.user.userId,
      action: 'CATEGORY_CREATED',
      resource: 'categories',
      resourceId: category.id,
      details: { name },
      ip: getClientIp(req),
    });

    res.status(201).json({ success: true, message: 'Catégorie créée', category });
  })
);

// ─────────────────────────────────────────────
// PUT /api/categories/:id
// ─────────────────────────────────────────────
router.put(
  '/:id',
  requirePermission('categories', 'update'),
  validate([
    param('id').isInt().toInt(),
    body('name').optional().trim().isLength({ min: 2, max: 100 }),
    body('description').optional().trim().isLength({ max: 500 }),
    body('color').optional().matches(/^#[0-9a-fA-F]{6}$/),
    body('parent_id').optional({ nullable: true }).isInt().toInt(),
    body('order_index').optional().isInt().toInt(),
    body('is_active').optional().isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const { name, description, color, parent_id, order_index, is_active } = req.body;

    const category = await get('SELECT * FROM categories WHERE id = ?', [targetId]);
    if (!category) throw new AppError('Catégorie introuvable', 404, 'CATEGORY_NOT_FOUND');

    // Interdire l'auto-parenté
    if (parent_id === targetId) {
      throw new AppError('Une catégorie ne peut pas être sa propre parente', 400, 'SELF_PARENT');
    }

    // Vérifier parent (et éviter les cycles basiques)
    if (parent_id) {
      const parent = await get('SELECT id, parent_id FROM categories WHERE id = ?', [parent_id]);
      if (!parent) throw new AppError('Catégorie parente introuvable', 404, 'PARENT_NOT_FOUND');
      // Détection cycle : le parent ne doit pas descendre de targetId
      let current = parent;
      const visited = new Set();
      while (current) {
        if (current.id === targetId) {
          throw new AppError('Cycle détecté dans la hiérarchie', 400, 'CYCLE_DETECTED');
        }
        if (!current.parent_id || visited.has(current.id)) break;
        visited.add(current.id);
        current = await get('SELECT id, parent_id FROM categories WHERE id = ?', [current.parent_id]);
      }
    }

    // Unicité du nom si changé
    if (name && name !== category.name) {
      const existing = await get('SELECT id FROM categories WHERE name = ? AND id != ?', [name, targetId]);
      if (existing) throw new AppError('Ce nom de catégorie existe déjà', 409, 'CATEGORY_NAME_EXISTS');
    }

    await run(
      `UPDATE categories SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        color = COALESCE(?, color),
        parent_id = ?,
        order_index = COALESCE(?, order_index),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        name,
        description,
        color,
        parent_id === undefined ? category.parent_id : parent_id,
        order_index,
        is_active === undefined ? category.is_active : (is_active ? 1 : 0),
        targetId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'CATEGORY_UPDATED',
      resource: 'categories',
      resourceId: targetId,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM categories WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Catégorie mise à jour', category: updated });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/categories/:id
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  requirePermission('categories', 'delete'),
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    const category = await get('SELECT * FROM categories WHERE id = ?', [targetId]);
    if (!category) throw new AppError('Catégorie introuvable', 404, 'CATEGORY_NOT_FOUND');

    // Vérifier qu'aucune boutique / sous-catégorie n'y est rattachée
    const boutiqueCount = await get(
      'SELECT COUNT(*) AS c FROM boutiques WHERE category_id = ? AND is_active = 1',
      [targetId]
    );
    if (boutiqueCount.c > 0) {
      throw new AppError(
        `Impossible : ${boutiqueCount.c} boutique(s) rattachée(s)`,
        409,
        'CATEGORY_HAS_BOUTIQUES'
      );
    }

    const childCount = await get('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?', [targetId]);
    if (childCount.c > 0) {
      throw new AppError(
        `Impossible : ${childCount.c} sous-catégorie(s) existent`,
        409,
        'CATEGORY_HAS_CHILDREN'
      );
    }

    // Soft delete
    await run('UPDATE categories SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [targetId]);

    await logAction({
      userId: req.user.userId,
      action: 'CATEGORY_DELETED',
      resource: 'categories',
      resourceId: targetId,
      details: { name: category.name },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Catégorie supprimée (désactivée)' });
  })
);

module.exports = router;