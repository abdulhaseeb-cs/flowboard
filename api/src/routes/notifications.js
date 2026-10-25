const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { toNotification } = require('../lib/events');
const { toId } = require('../lib/access');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const [list, unread] = await Promise.all([
    db.query(
      `SELECT n.*, a.name AS actor_name, a.avatar_color AS actor_color
         FROM notifications n LEFT JOIN users a ON a.id = n.actor_id
        WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 30`,
      [req.user.id],
    ),
    db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]),
  ]);
  res.json({ notifications: list.rows.map(toNotification), unread: unread.rows[0].n });
});

router.post('/read-all', async (req, res) => {
  await db.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
});

router.post('/:id/read', async (req, res) => {
  await db.query('UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [toId(req.params.id), req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
