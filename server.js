const { createApp } = require('./src/app');
const storage = require('./src/storage');
const { port } = require('./src/config');

const app = createApp();

if (require.main === module) {
  storage.ensureReady()
    .then(() => {
      const server = app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
      server.on('error', error => {
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${port} is already in use. Close the existing server or restart with PORT=3001.`);
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
