const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(__dirname, '..', 'test-data.sqlite');

const { app } = require('../server');

test('users can sign up, log in, create a group, and join it', async () => {
  const user1 = request.agent(app);
  const user2 = request.agent(app);

  const signup1 = await user1.post('/api/auth/signup').send({
    username: 'Ada',
    email: 'ada@example.com',
    password: 'secret123'
  });
  assert.equal(signup1.status, 201);

  const signup2 = await user2.post('/api/auth/signup').send({
    username: 'Grace',
    email: 'grace@example.com',
    password: 'secret123'
  });
  assert.equal(signup2.status, 201);

  const login1 = await user1.post('/api/auth/login').send({
    email: 'ada@example.com',
    password: 'secret123'
  });
  assert.equal(login1.status, 200);

  const createGroup = await user1.post('/api/groups').send({ name: 'North Atlantic' });
  assert.equal(createGroup.status, 201);
  assert.ok(createGroup.body.group.code);

  const joinGroup = await user2.post('/api/groups/join').send({ code: createGroup.body.group.code });
  assert.equal(joinGroup.status, 200);

  const groupDetails = await user1.get(`/api/groups/${createGroup.body.group.id}`);
  assert.equal(groupDetails.status, 200);
  assert.equal(groupDetails.body.group.members.length, 2);
});
