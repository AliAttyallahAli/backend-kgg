// backend/routes/notifications.routes.js
const express = require('express');
const { param, query: qv } = require('express-validator');
const router = express.Router();

const { run, query, get } = require('../database/db');
const { authenticateToken } = require('../middlewares/auth');
const { validate } = require('../middlewares/validate');
const { asyncHandler, AppError } = require('../middlewares/errorHandler');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// GET /api/notifications
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    qv('unread_only').optional().isIn(['0', '1']),
  ]),
  asyncHandler(async (req, res) => {
    const page = req.query.page || 1;
    const limit = req.query.limit || 30;
    const offset = (page - 1) * limit;

    const conditions = ['user_id = ?'];
    const params = [req.user.userId];

    if (req.query.unread_only === '1') {
      conditions.push('is_read = 0');
    }

    const where = conditions.join(' AND ');

    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM notifications WHERE ${where}`,
      params
    );
    const unreadRow = await get(
      `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0`,
      [req.user.userId]
    );

    const rows = await query(
      `SELECT * FROM notifications WHERE ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      unread: unreadRow.unread,
      pagination: {
        page, limit,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / limit),
      },
    });
  })
);

// ─────────────────────────────────────────────
// PUT /api/notifications/:id/read
// ─────────────────────────────────────────────
router.put(
  '/:id/read',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const target = await get(
      'SELECT * FROM notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    );
    if (!target) throw new AppError('Notification introuvable', 404, 'NOTIF_NOT_FOUND');

    await run('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Marquée comme lue' });
  })
);

// ─────────────────────────────────────────────
// PUT /api/notifications/read-all
// ─────────────────────────────────────────────
router.put(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await run(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [req.user.userId]
    );
    res.json({ success: true, message: 'Toutes marquées comme lues', updated: result.changes });
  })
);

// ─────────────────────────────────────────────
// DELETE /api/notifications/:id
// ─────────────────────────────────────────────
router.delete(
  '/:id',
  validate([param('id').isInt().toInt()]),
  asyncHandler(async (req, res) => {
    const target = await get(
      'SELECT * FROM notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    );
    if (!target) throw new AppError('Notification introuvable', 404, 'NOTIF_NOT_FOUND');

    await run('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Supprimée' });
  })
);

module.exports = router;