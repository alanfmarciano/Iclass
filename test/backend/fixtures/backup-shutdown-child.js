// Processo filho de test/backend/backup-destino.test.js: o servidor de verdade pelo
// startServer (server-main-child.js, com o desligamento ordenado do SIGTERM), com a
// gravação do ZIP trocada por uma lenta que só termina quando o desligamento a
// interrompe. Serve para conferir, de ponta a ponta, que o "Fazer backup agora" em
// andamento recebe a resposta (503 retryable) antes de a porta derrubar a conexão, e que
// o .parcial não fica para trás.
const fs = require('node:fs');
const path = require('node:path');
const archive = require('../../../backend/utils/backupArchive.js');

archive.saveBackupZip = async options => {
    const partial = path.join(options.dir, `${options.name}.parcial`);
    fs.mkdirSync(options.dir, { recursive: true });
    fs.writeFileSync(partial, 'pela metade');
    process.stdout.write('@@BACKUP_STARTED\n');
    await new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        const stop = () => {
            clearInterval(keepAlive);
            fs.rmSync(partial, { force: true });
            reject(archive.backupAbortedError());
        };
        if (!options.signal) return;
        if (options.signal.aborted) stop();
        else options.signal.addEventListener('abort', stop, { once: true });
    });
};

require('./server-main-child.js');
