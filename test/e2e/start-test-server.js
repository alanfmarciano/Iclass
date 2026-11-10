const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-e2e-'));
process.env.TEST_MODE = '1';
process.env.ICLASS_ADMIN_SETUP_MODE = '1';
process.env.ICLASS_ADMIN_SETUP_TOKEN = 'e2e-local-admin-token-32-characters';
process.env.PORT = '3132';
process.env.ICLASS_DATA_DIR = path.join(root, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(root, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(root, 'archives');
// Verificador de gravação parcial (H1): toda alteração fora do only de uma gravação
// parcial aparece no log do servidor como [VERIFICAÇÃO DE GRAVAÇÃO].
if (!process.env.ICLASS_VERIFY_SAVES) process.env.ICLASS_VERIFY_SAVES = '1';
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

require('../../backend/server.js').startServer().catch(error => {
    console.error(error);
    process.exit(1);
});
