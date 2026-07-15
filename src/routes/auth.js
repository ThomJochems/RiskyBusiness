const express = require('express');
const { requireAuth } = require('../middleware/require-auth');
const { hashPassword, verifyPassword } = require('../security/passwords');

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email };
}

function createAuthRouter(storage) {
  const router = express.Router();

  router.post('/signup', async (req, res) => {
    try {
      const { username, email, password } = req.body;
      if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
      }
      if (await storage.getUserByEmail(email)) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      const user = await storage.createUser(username, email, hashPassword(password));
      req.session.userId = user.id;
      res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await storage.getUserByEmail(email);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      req.session.userId = user.id;
      res.json({ user: publicUser(user) });
    } catch (error) {
      res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  router.get('/me', requireAuth, async (req, res) => {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  });

  return router;
}

module.exports = { createAuthRouter };
