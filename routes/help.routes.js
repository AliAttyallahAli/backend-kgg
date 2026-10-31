// backend/routes/help.routes.js
const express = require('express');
const { body, param, query: qv } = require('express-validator');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const { get, run, query } = require('../database/db');
const { authenticateToken, getClientIp } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');
const { logAction } = require('../services/auditService');
const { uploadGuide } = require('../middlewares/upload');

router.use(authenticateToken);

const VALID_TYPES = ['guide', 'video', 'link'];
const VALID_CATEGORIES = [
  'general', 'demarrage', 'produits', 'commandes', 'ventes',
  'personnel', 'charges', 'alkherpay', 'rapports', 'structure', 'finance',
];

// ═══════════════════════════════════════════════
// GET /api/help/resources — liste publique (tous rôles)
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// GET /api/help/resources — liste publique
// ═══════════════════════════════════════════════
router.get(
  '/resources',
  validate([
    qv('type').optional({ values: 'falsy' }).isIn([...VALID_TYPES, 'all']),
    qv('category').optional({ values: 'falsy' }).isIn([...VALID_CATEGORIES, 'all']),
    qv('search').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    // ✅ On qualifie toutes les colonnes avec r. pour éviter l'ambiguïté
    const conditions = ['r.is_active = 1'];
    const params = [];

    if (req.query.type && req.query.type !== 'all') {
      conditions.push('r.type = ?');
      params.push(req.query.type);
    }
    if (req.query.category && req.query.category !== 'all') {
      conditions.push('r.category = ?');
      params.push(req.query.category);
    }
    if (req.query.search) {
      conditions.push('(r.title LIKE ? OR r.description LIKE ?)');
      const s = `%${req.query.search}%`;
      params.push(s, s);
    }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT r.id, r.type, r.category, r.title, r.description,
              r.url, r.file_path, r.file_size, r.mime_type, r.thumbnail,
              r.order_index, r.created_at,
              u.fullname AS created_by_name
       FROM help_resources r
       LEFT JOIN users u ON r.created_by = u.id
       WHERE ${where}
       ORDER BY r.order_index ASC, r.created_at DESC`,
      params
    );

    res.json({ success: true, data: rows });
  })
);
// ═══════════════════════════════════════════════
// POST /api/help/resources — créer (admin)
// ═══════════════════════════════════════════════
router.post(
  '/resources',
  requireAdmin,
  uploadGuide.single('file'),
  validate([
    body('type').isIn(VALID_TYPES).withMessage('Type invalide (guide/video/link)'),
    body('category').isIn(VALID_CATEGORIES).withMessage('Catégorie invalide'),
    body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Titre requis (3-200 car.)'),
    body('description').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
    body('url').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    body('order_index').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const { type, category, title, description, url, order_index } = req.body;
    const file = req.file;

    // Validation métier
    if (type === 'guide' && !file) {
      throw new AppError('Un fichier est requis pour un guide', 400, 'FILE_REQUIRED');
    }
    if ((type === 'video' || type === 'link') && !url) {
      throw new AppError('Une URL est requise pour une vidéo ou un lien', 400, 'URL_REQUIRED');
    }
    if (type === 'video' && !url.match(/(youtube\.com|youtu\.be)/)) {
      throw new AppError('URL YouTube invalide', 400, 'INVALID_YOUTUBE_URL');
    }

    const result = await run(
      `INSERT INTO help_resources
       (type, category, title, description, url, file_path, file_size, mime_type, order_index, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type, category, title.trim(), description || null, url || null,
        file ? file.path.replace(/\\/g, '/') : null,
        file ? file.size : null,
        file ? file.mimetype : null,
        order_index || 0,
        req.user.userId,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'HELP_RESOURCE_CREATED',
      resource: 'help_resources',
      resourceId: result.lastID,
      details: { type, category, title },
      ip: getClientIp(req),
    });

    const created = await get('SELECT * FROM help_resources WHERE id = ?', [result.lastID]);

    res.status(201).json({
      success: true,
      message: 'Ressource créée',
      data: created,
    });
  })
);

// ═══════════════════════════════════════════════
// PUT /api/help/resources/:id — modifier (admin)
// ═══════════════════════════════════════════════
router.put(
  '/resources/:id',
  requireAdmin,
  uploadGuide.single('file'),
  validate([
    param('id').isInt().toInt(),
    body('title').optional({ values: 'falsy' }).trim().isLength({ min: 3, max: 200 }),
    body('description').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
    body('category').optional({ values: 'falsy' }).isIn(VALID_CATEGORIES),
    body('url').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    body('order_index').optional({ values: 'falsy' }).isInt({ min: 0 }).toInt(),
    body('is_active').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const resource = await get('SELECT * FROM help_resources WHERE id = ?', [req.params.id]);
    if (!resource) throw new AppError('Ressource introuvable', 404, 'RESOURCE_NOT_FOUND');

    const { title, description, category, url, order_index, is_active } = req.body;
    const file = req.file;

    // Si nouveau fichier, supprimer l'ancien
    let newFilePath = resource.file_path;
    let newFileSize = resource.file_size;
    let newMimeType = resource.mime_type;

    if (file) {
      if (resource.file_path) {
        try {
          const abs = path.isAbsolute(resource.file_path)
            ? resource.file_path
            : path.join(__dirname, '..', resource.file_path);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch (e) {
          console.warn('⚠️ Ancien fichier non supprimé:', e.message);
        }
      }
      newFilePath = file.path.replace(/\\/g, '/');
      newFileSize = file.size;
      newMimeType = file.mimetype;
    }

    await run(
      `UPDATE help_resources SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        category = COALESCE(?, category),
        url = COALESCE(?, url),
        file_path = ?,
        file_size = ?,
        mime_type = ?,
        order_index = COALESCE(?, order_index),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        title, description, category, url,
        newFilePath, newFileSize, newMimeType,
        order_index,
        is_active === undefined ? resource.is_active : (is_active ? 1 : 0),
        req.params.id,
      ]
    );

    await logAction({
      userId: req.user.userId,
      action: 'HELP_RESOURCE_UPDATED',
      resource: 'help_resources',
      resourceId: req.params.id,
      ip: getClientIp(req),
    });

    const updated = await get('SELECT * FROM help_resources WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Ressource mise à jour', data: updated });
  })
);

// ═══════════════════════════════════════════════
// DELETE /api/help/resources/:id — supprimer (admin)
// ═══════════════════════════════════════════════
router.delete(
  '/resources/:id',
  requireAdmin,
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const resource = await get('SELECT * FROM help_resources WHERE id = ?', [req.params.id]);
    if (!resource) throw new AppError('Ressource introuvable', 404, 'RESOURCE_NOT_FOUND');

    // Supprimer le fichier physique
    if (resource.file_path) {
      try {
        const abs = path.isAbsolute(resource.file_path)
          ? resource.file_path
          : path.join(__dirname, '..', resource.file_path);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (e) {
        console.warn('⚠️ Fichier non supprimé:', e.message);
      }
    }

    await run('DELETE FROM help_resources WHERE id = ?', [req.params.id]);

    await logAction({
      userId: req.user.userId,
      action: 'HELP_RESOURCE_DELETED',
      resource: 'help_resources',
      resourceId: req.params.id,
      details: { title: resource.title },
      ip: getClientIp(req),
    });

    res.json({ success: true, message: 'Ressource supprimée' });
  })
);

module.exports = router;