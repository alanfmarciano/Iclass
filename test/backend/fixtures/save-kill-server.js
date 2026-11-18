// Servidor de test/backend/save-response.test.js para o kill -9 e o Reiniciar: sobe o
// app numa porta livre com o banco de ICLASS_DATA_DIR, cria o aluno (e o administrador,
// quando dado) de teste e imprime "PORT=<porta>". No kill -9 o teste mata o processo
// com SIGKILL logo depois do 200; no Reiniciar o processo sai sozinho.
// Uso: node save-kill-server.js <email do aluno> <senha> [<email do admin> <senha>]
const childProcess = require('node:child_process');
const db = require('../../../backend/database.js');
const { createApp, installProcessHandlers } = require('../../../backend/server.js');
const serverLifecycle = require('../../../backend/utils/serverLifecycle.js');

const STUDENT_EMAIL = process.argv[2] || 'kill@teste.local';
const STUDENT_PASSWORD = process.argv[3] || 'senha-kill';
const ADMIN_EMAIL = process.argv[4] || '';
const ADMIN_PASSWORD = process.argv[5] || '';

// O Reiniciar sem supervisor dispara um novo servidor (node backend/server.js; no Windows
// pelo cmd.exe): no teste ele nunca roda de verdade (subiria um servidor com os dados
// reais); só avisa.
childProcess.spawn = (command, args) => {
    process.stdout.write(`SPAWN=${[command, ...(args || [])].join(' ')}\n`);
    return { unref() {}, on() { return this; } };
};

(async () => {
    await db.init();
    db.memory.students.push({
        name: 'Aluno do kill',
        email: STUDENT_EMAIL,
        password: db.hashPassword(STUDENT_PASSWORD),
        status: 'Ativo',
        classes: [],
    });
    if (ADMIN_EMAIL) {
        db.memory.admins.push({
            name: 'Admin do reinício',
            email: ADMIN_EMAIL,
            password: db.hashPassword(ADMIN_PASSWORD),
            role: 'admin',
            mustChangePassword: false,
        });
    }
    await db.save();
    const app = createApp();
    const server = app.listen(0, '127.0.0.1', () => {
        app.set('serverInstance', server);
        // O desligamento ordenado do servidor de verdade (H3c), que o Reiniciar usa.
        installProcessHandlers({ server });
        serverLifecycle.markReady();
        process.stdout.write(`PORT=${server.address().port}\n`);
    });
    process.on('exit', code => process.stdout.write(`EXIT=${code}\n`));
})().catch(err => {
    process.stdout.write(`FALHA=${String((err && err.stack) || err).replace(/\n/g, ' | ')}\n`);
    process.exit(1);
});
