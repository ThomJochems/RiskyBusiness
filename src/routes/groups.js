const express = require('express');
const { requireAuth } = require('../middleware/require-auth');

function createGroupsRouter(storage) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.json({ groups: await storage.listUserGroups(req.session.userId) });
  });

  router.post('/', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    const group = await storage.createGroup(name, req.session.userId);
    res.status(201).json({ group: { id: group.id, name, code: group.code } });
  });

  router.post('/join', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Group code is required' });
    const group = await storage.getGroupByCode(code);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!await storage.joinGroup(group.id, req.session.userId)) {
      return res.status(200).json({ message: 'Already joined' });
    }
    res.json({ group: { id: group.id, name: group.name, code: group.code } });
  });

  async function getAccessibleGroup(req, res) {
    const group = await storage.getGroupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'Group not found' }); return null; }
    if (!await storage.getGroupMembership(group.id, req.session.userId)) {
      res.status(403).json({ error: 'Not a member of this group' }); return null;
    }
    return group;
  }

  router.get('/:id', async (req, res) => {
    const group = await getAccessibleGroup(req, res);
    if (!group) return;
    const [members, state] = await Promise.all([
      storage.getGroupMembers(group.id), storage.getGameState(group.id)
    ]);
    res.json({ group: { id: group.id, name: group.name, code: group.code, members, state } });
  });

  router.get('/:id/game', async (req, res) => {
    const group = await getAccessibleGroup(req, res);
    if (group) res.json({ game: await storage.getGameState(group.id) });
  });

  router.post('/:id/game', async (req, res) => {
    const group = await getAccessibleGroup(req, res);
    if (!group) return;
    await storage.saveGameState(group.id, req.body || {});
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createGroupsRouter };
