// Processo de test/backend/supervisor.test.js: o supervisor de verdade
// (backend/supervisor.js), com o servidor de server-main-child.js (o startServer sem a
// conferência do build de web/dist).
const path = require('node:path');
const { createSupervisor } = require('../../../backend/supervisor.js');

createSupervisor({ serverScript: path.join(__dirname, 'server-main-child.js') }).run();
