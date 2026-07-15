const fs = require('node:fs');
const { databasePath, databaseUrl } = require('./config');

const usePostgres = Boolean(databaseUrl);
const pool = usePostgres ? createPostgresPool() : null;
let store;
let initialized = false;

const EMPTY_GAME = { troops: {}, tiebreakers: {}, lastUpdated: {}, selectedPlayer: null, kissLog: [] };
const initialStore = () => ({ users: [], groups: [], group_members: [], game_state: [] });
const nextId = items => items.length ? Math.max(...items.map(item => item.id)) + 1 : 1;
const createGroupCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function createPostgresPool() {
  const { Pool } = require('pg');
  return new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
}

function saveStore() {
  fs.writeFileSync(databasePath, JSON.stringify(store, null, 2));
}

function loadStore() {
  fs.mkdirSync(require('node:path').dirname(databasePath), { recursive: true });
  if (!fs.existsSync(databasePath)) {
    store = initialStore();
    saveStore();
    return;
  }
  try { store = JSON.parse(fs.readFileSync(databasePath, 'utf8')); }
  catch (error) { store = initialStore(); saveStore(); }
}

async function ensureReady() {
  if (initialized) return;
  if (!usePostgres) loadStore();
  else await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS group_members (id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(group_id, user_id));
    CREATE TABLE IF NOT EXISTS game_state (id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL DEFAULT '{}', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);
  initialized = true;
}

async function findOne(postgresQuery, params, collection, predicate) {
  await ensureReady();
  if (usePostgres) return (await pool.query(postgresQuery, params)).rows[0] || null;
  return store[collection].find(predicate) || null;
}

const getUserByEmail = email => findOne('SELECT * FROM users WHERE email = $1', [email], 'users', user => user.email === email);
const getUserById = id => findOne('SELECT * FROM users WHERE id = $1', [Number(id)], 'users', user => user.id === Number(id));
const getGroupById = id => findOne('SELECT * FROM groups WHERE id = $1', [Number(id)], 'groups', group => group.id === Number(id));
const getGroupByCode = code => findOne('SELECT * FROM groups WHERE code = $1', [code.toUpperCase()], 'groups', group => group.code === code.toUpperCase());
const getGroupMembership = (groupId, userId) => findOne('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [Number(groupId), Number(userId)], 'group_members', member => member.group_id === Number(groupId) && member.user_id === Number(userId));

async function createUser(username, email, passwordHash) {
  await ensureReady();
  if (usePostgres) return (await pool.query('INSERT INTO users (username, email, password_hash, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *', [username, email, passwordHash])).rows[0];
  const user = { id: nextId(store.users), username, email, password_hash: passwordHash, created_at: new Date().toISOString() };
  store.users.push(user); saveStore(); return user;
}

async function createGroup(name, ownerId) {
  await ensureReady();
  const code = createGroupCode();
  if (usePostgres) {
    const group = (await pool.query('INSERT INTO groups (name, code, owner_id, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *', [name, code, Number(ownerId)])).rows[0];
    await pool.query('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)', [group.id, Number(ownerId), 'owner']);
    await pool.query('INSERT INTO game_state (group_id, payload, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)', [group.id, '{}']);
    return group;
  }
  const group = { id: nextId(store.groups), name, code, owner_id: ownerId, created_at: new Date().toISOString() };
  store.groups.push(group);
  store.group_members.push({ id: nextId(store.group_members), group_id: group.id, user_id: ownerId, role: 'owner', joined_at: new Date().toISOString() });
  store.game_state.push({ id: nextId(store.game_state), group_id: group.id, payload: '{}', updated_at: new Date().toISOString() });
  saveStore(); return group;
}

async function joinGroup(groupId, userId) {
  await ensureReady();
  if (await getGroupMembership(groupId, userId)) return false;
  if (usePostgres) await pool.query('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)', [Number(groupId), Number(userId), 'member']);
  else { store.group_members.push({ id: nextId(store.group_members), group_id: Number(groupId), user_id: Number(userId), role: 'member', joined_at: new Date().toISOString() }); saveStore(); }
  return true;
}

async function getGroupMembers(groupId) {
  await ensureReady();
  if (usePostgres) return (await pool.query(`SELECT u.id, u.username, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1 ORDER BY CASE WHEN gm.role = 'owner' THEN 0 ELSE 1 END, u.username ASC`, [Number(groupId)])).rows;
  return store.group_members.filter(m => m.group_id === Number(groupId)).map(m => {
    const user = store.users.find(u => u.id === m.user_id); return user && { id: user.id, username: user.username, role: m.role };
  }).filter(Boolean).sort((a, b) => a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'owner' ? -1 : 1);
}

function parseGame(payload) { try { return JSON.parse(payload); } catch (error) { return { ...EMPTY_GAME }; } }
async function getGameState(groupId) {
  await ensureReady();
  if (usePostgres) return parseGame((await pool.query('SELECT payload FROM game_state WHERE group_id = $1', [Number(groupId)])).rows[0]?.payload || '{}');
  const state = store.game_state.find(entry => entry.group_id === Number(groupId));
  return state ? parseGame(state.payload) : { ...EMPTY_GAME };
}

async function saveGameState(groupId, payload) {
  await ensureReady(); const serialized = JSON.stringify(payload || {});
  if (usePostgres) return pool.query(`INSERT INTO game_state (group_id, payload, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (group_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP`, [Number(groupId), serialized]);
  const existing = store.game_state.find(entry => entry.group_id === Number(groupId));
  if (existing) { existing.payload = serialized; existing.updated_at = new Date().toISOString(); }
  else store.game_state.push({ id: nextId(store.game_state), group_id: Number(groupId), payload: serialized, updated_at: new Date().toISOString() });
  saveStore();
}

async function listUserGroups(userId) {
  await ensureReady();
  if (usePostgres) return (await pool.query(`SELECT g.id, g.name, g.code, g.owner_id, g.created_at, COUNT(gm.id) AS member_count FROM groups g JOIN group_members me ON me.group_id = g.id AND me.user_id = $1 LEFT JOIN group_members gm ON gm.group_id = g.id GROUP BY g.id ORDER BY g.created_at DESC`, [Number(userId)])).rows;
  const ids = new Set(store.group_members.filter(m => m.user_id === Number(userId)).map(m => m.group_id));
  return store.groups.filter(g => ids.has(g.id)).map(g => ({ ...g, member_count: store.group_members.filter(m => m.group_id === g.id).length })).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

module.exports = { type: usePostgres ? 'postgres' : 'json', ensureReady, getUserByEmail, getUserById, createUser, getGroupById, getGroupByCode, getGroupMembership, getGroupMembers, createGroup, joinGroup, getGameState, saveGameState, listUserGroups };
