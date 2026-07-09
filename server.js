const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'risky-business-data.json');
const DATABASE_URL = process.env.DATABASE_URL;
const USE_POSTGRES = Boolean(DATABASE_URL);

let pool = null;
let store = null;
let initialized = false;

if (USE_POSTGRES) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
} else if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function createGroupCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

function loadJsonStore() {
  if (!fs.existsSync(DB_PATH)) {
    const initialStore = { users: [], groups: [], group_members: [], game_state: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialStore, null, 2));
    return initialStore;
  }

  try {
    const contents = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(contents);
  } catch (error) {
    const fallback = { users: [], groups: [], group_members: [], game_state: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function saveJsonStore() {
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

function nextId(items) {
  if (!items.length) return 1;
  return Math.max(...items.map(item => item.id)) + 1;
}

async function ensureStorageReady() {
  if (initialized) return;

  if (USE_POSTGRES) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        owner_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS game_state (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL UNIQUE,
        payload TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    store = loadJsonStore();
  }

  initialized = true;
}

async function getUserByEmail(email) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0] || null;
  }

  return store.users.find(user => user.email === email) || null;
}

async function getUserById(id) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [Number(id)]);
    return result.rows[0] || null;
  }

  return store.users.find(user => user.id === Number(id)) || null;
}

async function getGroupByCode(code) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query('SELECT * FROM groups WHERE code = $1', [code.toUpperCase()]);
    return result.rows[0] || null;
  }

  return store.groups.find(group => group.code === code.toUpperCase()) || null;
}

async function getGroupById(id) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query('SELECT * FROM groups WHERE id = $1', [Number(id)]);
    return result.rows[0] || null;
  }

  return store.groups.find(group => group.id === Number(id)) || null;
}

async function getGroupMembership(groupId, userId) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [Number(groupId), Number(userId)]);
    return result.rows[0] || null;
  }

  return store.group_members.find(member => member.group_id === Number(groupId) && member.user_id === Number(userId)) || null;
}

async function getGroupMembers(groupId) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query(`
      SELECT u.id, u.username, gm.role
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
      ORDER BY CASE WHEN gm.role = 'owner' THEN 0 ELSE 1 END, u.username ASC
    `, [Number(groupId)]);
    return result.rows;
  }

  return store.group_members
    .filter(member => member.group_id === Number(groupId))
    .map(member => {
      const user = store.users.find(entry => entry.id === member.user_id);
      return user ? { id: user.id, username: user.username, role: member.role } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.role === b.role) return a.username.localeCompare(b.username);
      return a.role === 'owner' ? -1 : 1;
    });
}

async function getGameState(groupId) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query('SELECT payload FROM game_state WHERE group_id = $1', [Number(groupId)]);
    const payload = result.rows[0]?.payload || '{}';
    try {
      return JSON.parse(payload);
    } catch (error) {
      return { troops: {}, tiebreakers: {}, lastUpdated: {}, selectedPlayer: null, kissLog: [] };
    }
  }

  const state = store.game_state.find(entry => entry.group_id === Number(groupId));
  if (!state) return { troops: {}, tiebreakers: {}, lastUpdated: {}, selectedPlayer: null, kissLog: [] };
  try {
    return JSON.parse(state.payload);
  } catch (error) {
    return { troops: {}, tiebreakers: {}, lastUpdated: {}, selectedPlayer: null, kissLog: [] };
  }
}

async function saveGameState(groupId, payload) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const serialized = JSON.stringify(payload || {});
    await pool.query(`
      INSERT INTO game_state (group_id, payload, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (group_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP
    `, [Number(groupId), serialized]);
    return;
  }

  const groupIdNumber = Number(groupId);
  const existing = store.game_state.find(entry => entry.group_id === groupIdNumber);
  if (existing) {
    existing.payload = JSON.stringify(payload || {});
    existing.updated_at = new Date().toISOString();
  } else {
    store.game_state.push({ id: nextId(store.game_state), group_id: groupIdNumber, payload: JSON.stringify(payload || {}), updated_at: new Date().toISOString() });
  }
  saveJsonStore();
}

async function createUser(username, email, passwordHash) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING id, username, email, password_hash, created_at',
      [username, email, passwordHash]
    );
    return result.rows[0];
  }

  const user = {
    id: nextId(store.users),
    username,
    email,
    password_hash: passwordHash,
    created_at: new Date().toISOString()
  };
  store.users.push(user);
  saveJsonStore();
  return user;
}

async function createGroup(name, ownerId) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const code = createGroupCode();
    const result = await pool.query(
      'INSERT INTO groups (name, code, owner_id, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING id, name, code, owner_id, created_at',
      [name, code, Number(ownerId)]
    );
    const group = result.rows[0];
    await pool.query('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)', [group.id, Number(ownerId), 'owner']);
    await pool.query('INSERT INTO game_state (group_id, payload, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)', [group.id, '{}']);
    return group;
  }

  const group = {
    id: nextId(store.groups),
    name,
    code: createGroupCode(),
    owner_id: ownerId,
    created_at: new Date().toISOString()
  };
  store.groups.push(group);
  store.group_members.push({ id: nextId(store.group_members), group_id: group.id, user_id: ownerId, role: 'owner', joined_at: new Date().toISOString() });
  store.game_state.push({ id: nextId(store.game_state), group_id: group.id, payload: '{}', updated_at: new Date().toISOString() });
  saveJsonStore();
  return group;
}

async function joinGroup(groupId, userId) {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const existing = await getGroupMembership(groupId, userId);
    if (existing) return false;
    await pool.query('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)', [Number(groupId), Number(userId), 'member']);
    return true;
  }

  const existing = store.group_members.find(member => member.group_id === Number(groupId) && member.user_id === Number(userId));
  if (existing) return false;
  store.group_members.push({ id: nextId(store.group_members), group_id: Number(groupId), user_id: Number(userId), role: 'member', joined_at: new Date().toISOString() });
  saveJsonStore();
  return true;
}

async function listGroups() {
  await ensureStorageReady();
  if (USE_POSTGRES) {
    const result = await pool.query(`
      SELECT g.id, g.name, g.code, g.owner_id, g.created_at, COUNT(gm.id) AS member_count
      FROM groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    return result.rows;
  }

  return store.groups
    .map(group => ({
      id: group.id,
      name: group.name,
      code: group.code,
      owner_id: group.owner_id,
      created_at: group.created_at,
      member_count: store.group_members.filter(member => member.group_id === group.id).length
    }))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

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

app.get('/api/health', async (req, res) => {
  await ensureStorageReady();
  res.json({ ok: true, storage: USE_POSTGRES ? 'postgres' : 'json' });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (await getUserByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = hashPassword(password);
    const user = await createUser(username, email, passwordHash);

    req.session.userId = user.id;
    res.status(201).json({ user: { id: user.id, username, email } });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = verifyPassword(password, user.password_hash);
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

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/groups', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });

  const group = await createGroup(name, req.session.userId);
  res.status(201).json({ group: { id: group.id, name, code: group.code } });
});

app.post('/api/groups/join', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Group code is required' });

  const group = await getGroupByCode(code);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const joined = await joinGroup(group.id, req.session.userId);
  if (!joined) return res.status(200).json({ message: 'Already joined' });

  res.json({ group: { id: group.id, name: group.name, code: group.code } });
});

app.get('/api/groups/:id', requireAuth, async (req, res) => {
  const group = await getGroupById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = await getGroupMembership(group.id, req.session.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const members = await getGroupMembers(group.id);
  const state = await getGameState(group.id);
  res.json({ group: { id: group.id, name: group.name, code: group.code, members, state } });
});

app.get('/api/groups/:id/game', requireAuth, async (req, res) => {
  const group = await getGroupById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = await getGroupMembership(group.id, req.session.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  res.json({ game: await getGameState(group.id) });
});

app.post('/api/groups/:id/game', requireAuth, async (req, res) => {
  const group = await getGroupById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = await getGroupMembership(group.id, req.session.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  await saveGameState(group.id, req.body || {});
  res.json({ ok: true });
});

app.get('/groups/:id/play', requireAuth, async (req, res) => {
  const group = await getGroupById(req.params.id);
  if (!group) return res.status(404).send('Group not found');

  const isMember = await getGroupMembership(group.id, req.session.userId);
  if (!isMember) return res.status(403).send('Not a member of this group');

  res.sendFile(path.join(__dirname, 'Risky_business-Thoms-Laptop.html'));
});

app.get('/api/groups', requireAuth, async (req, res) => {
  const groups = await listGroups();
  res.json({ groups });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  ensureStorageReady()
    .then(() => {
      const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${PORT} is already in use. Close the existing server or restart with PORT=3001.`);
          process.exit(1);
        }
        throw error;
      });
    })
    .catch(error => {
      console.error('Failed to initialize storage', error);
      process.exit(1);
    });
}

module.exports = { app };
