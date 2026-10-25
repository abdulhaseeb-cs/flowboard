const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../lib/db');
const config = require('../config');
const { HttpError, validate } = require('../lib/errors');
const { signToken, requireAuth, rateLimit } = require('../lib/auth');

const router = express.Router();
const limiter = rateLimit('auth', config.authRateLimit);

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316'];
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, color: u.avatar_color });

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

router.post('/register', limiter, async (req, res) => {
  const data = validate(registerSchema, req.body);
  const hash = await bcrypt.hash(data.password, 10);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  try {
    const { rows } = await db.query(
      'INSERT INTO users (name, email, password_hash, avatar_color) VALUES ($1, $2, $3, $4) RETURNING *',
      [data.name, data.email, hash, color],
    );
    res.status(201).json({ token: signToken(rows[0]), user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists', { email: 'Already registered' });
    throw err;
  }
});

router.post('/login', limiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  // Same message for unknown email and wrong password => no account enumeration
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  res.json({ token: signToken(rows[0]), user: publicUser(rows[0]) });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.patch('/me', requireAuth, async (req, res) => {
  const { name } = validate(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
  const { rows } = await db.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING *', [name, req.user.id]);
  res.json({ user: publicUser(rows[0]) });
});

module.exports = router;
module.exports.publicUser = publicUser;
