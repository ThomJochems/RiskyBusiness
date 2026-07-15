const express = require('express');
const session = require('express-session');
const path = require('node:path');
const { rootDirectory, sessionSecret } = require('./config');
const storage = require('./storage');
const { createAuthRouter } = require('./routes/auth');
const { createGroupsRouter } = require('./routes/groups');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(rootDirectory, 'public')));
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));

  app.get('/api/health', async (req, res) => {
    await storage.ensureReady();
    res.json({ ok: true, storage: storage.type });
  });
  app.use('/api/auth', createAuthRouter(storage));
  app.use('/api/groups', createGroupsRouter(storage));

  app.get('/groups/:id/play', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
    const group = await storage.getGroupById(req.params.id);
    if (!group) return res.status(404).send('Group not found');
    if (!await storage.getGroupMembership(group.id, req.session.userId)) {
      return res.status(403).send('Not a member of this group');
    }
    res.sendFile(path.join(rootDirectory, 'Risky_business-Thoms-Laptop.html'));
  });

  app.get('*', (req, res) => res.sendFile(path.join(rootDirectory, 'public', 'index.html')));
  return app;
}

module.exports = { createApp };
