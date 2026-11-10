// Pasta de dados dentro do OneDrive (H1-c, CONF-05).
//
// O OneDrive (e o antivírus) abrem o database.db e os arquivos -wal/-shm enquanto o
// IClass grava: travas, gravações que falham e cópias do banco pela metade. Quando a
// pasta de dados está dentro dele, o servidor avisa no console e o cartão Armazenamento
// da tela Sistema mostra o aviso. O teste com o OneDrive de verdade fica para o Windows.
//
// Regras (sem diferenciar maiúsculas, com barra ou contrabarra):
// - o caminho começa com a pasta do OneDrive informada pelo Windows (variáveis OneDrive,
//   OneDriveCommercial ou OneDriveConsumer);
// - ou algum trecho do caminho começa com "OneDrive" ("OneDrive", "OneDrive - Escola").
const path = require('path');

const ONEDRIVE_ENV_VARS = ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'];

const SYNCED_FOLDER_WARNING = 'A pasta de dados está dentro do OneDrive. Mova a pasta do IClass para fora dela (ex.: C:\\IClass) para evitar travas e cópias inconsistentes do banco.';

// Caminho comparável: barras normais, minúsculas e sem barra no fim.
function comparablePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function syncedFolderInfo(dirPath, env = process.env) {
    const raw = String(dirPath || '');
    if (!raw) return { inSyncedFolder: false, provider: null };
    const resolved = comparablePath(/^[a-z]:[\\/]/i.test(raw) || raw.startsWith('\\\\') ? raw : path.resolve(raw));
    const roots = ONEDRIVE_ENV_VARS
        .map(name => comparablePath(env && env[name]))
        .filter(Boolean);
    const underRoot = roots.some(root => resolved === root || resolved.startsWith(`${root}/`));
    const segment = resolved.split('/').some(part => part.startsWith('onedrive'));
    return underRoot || segment
        ? { inSyncedFolder: true, provider: 'OneDrive' }
        : { inSyncedFolder: false, provider: null };
}

module.exports = {
    SYNCED_FOLDER_WARNING,
    syncedFolderInfo,
};
