const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'risky-business.sqlite');

if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id),
    FOREIGN KEY(group_id) REFERENCES groups(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS game_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL UNIQUE,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(group_id) REFERENCES groups(id)
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function createGroupCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const info = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, passwordHash);

    req.session.userId = info.lastInsertRowid;
    res.status(201).json({ user: { id: info.lastInsertRowid, username, email } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    res.json({ user: { id: user.id, username: user.username, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/groups', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });

  const code = createGroupCode();
  const insertGroup = db.prepare('INSERT INTO groups (name, code, owner_id) VALUES (?, ?, ?)').run(name, code, req.session.userId);
  db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(insertGroup.lastInsertRowid, req.session.userId, 'owner');
  db.prepare('INSERT INTO game_state (group_id) VALUES (?)').run(insertGroup.lastInsertRowid);

  res.status(201).json({ group: { id: insertGroup.lastInsertRowid, name, code } });
});

app.post('/api/groups/join', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Group code is required' });

  const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(code.toUpperCase());
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const existing = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.session.userId);
  if (existing) return res.status(200).json({ message: 'Already joined' });

  db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(group.id, req.session.userId, 'member');
  res.json({ group: { id: group.id, name: group.name, code: group.code } });
});

app.get('/api/groups/:id', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.session.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const members = db.prepare('SELECT u.id, u.username, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.role DESC, u.username ASC').all(group.id);
  const state = db.prepare('SELECT payload FROM game_state WHERE group_id = ?').get(group.id);

  res.json({ group: { id: group.id, name: group.name, code: group.code, members, state: state ? JSON.parse(state.payload) : {} } });
});

app.get('/api/groups/:id/game', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.session.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const state = db.prepare('SELECT payload FROM game_state WHERE group_id = ?').get(group.id);
  res.json({ game: state ? JSON.parse(state.payload) : { troops: {}, tiebreakers: {}, lastUpdated: {}, selectedPlayer: null, kissLog: [] } });
});

app.post('/api/groups/:id/game', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.session.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const payload = JSON.stringify(req.body || {});
  db.prepare('INSERT INTO game_state (group_id, payload) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP').run(group.id, payload);
  res.json({ ok: true });
});

app.get('/groups/:id/play', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).send('Group not found');

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.session.userId);
  if (!isMember) return res.status(403).send('Not a member of this group');

  res.sendFile(path.join(__dirname, 'Risky_business-Thoms-Laptop.html'));
});

app.get('/api/groups', requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.code, g.owner_id, COUNT(gm.id) AS member_count
    FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `).all();
  res.json({ groups });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Close the existing server or restart with PORT=3001.`);
      process.exit(1);
    }
    throw error;
  });
}

module.exports = { app, db };
