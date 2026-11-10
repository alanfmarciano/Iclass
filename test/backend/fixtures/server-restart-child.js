// Processo filho de test/backend/server-restart.test.js: o servidor de verdade (o boot
// do prepareServer, o app do createApp e a porta aberta), sem a conferência do build do
// startServer (o node --test não depende de web/dist). PORT=0 abre uma porta livre, que
// sai no stdout como '@@READY {"port":N,"pid":P}'. SIGTERM: o desligamento ordenado do
// startServer (fecha a porta, db.close, que grava tudo, e sai com 0, o que marca a
// parada limpa no heartbeat). kill -9 é a queda: nada disso roda.
const db = require('../../../backend/database.js');
const { createApp, prepareServer } = require('../../../backend/server.js');

(async () => {
    await prepareServer();
    const app = createApp();
    const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
        process.stdout.write(`@@READY ${JSON.stringify({ port: server.address().port, pid: process.pid })}\n`);
    });
    process.once('SIGTERM', async () => {
        server.close();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        try { await db.close(); } finally { process.exit(0); }
    });
})().catch(err => {
    console.error(err);
    process.exit(1);
});
