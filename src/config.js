const path = require('node:path');

const rootDirectory = path.join(__dirname, '..');

module.exports = {
  rootDirectory,
  port: process.env.PORT || 3000,
  databasePath: process.env.DB_PATH || path.join(rootDirectory, 'risky-business-data.json'),
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret'
};
