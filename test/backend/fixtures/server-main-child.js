// Processo filho de test/backend/server-health.test.js e supervisor.test.js: o servidor
// de verdade pelo startServer (tratadores de erro e sinais, porta aberta antes do boot com
// o handler de boot, códigos de saída e desligamento ordenado), como "node
// backend/server.js". A única diferença é a conferência do build: o node --test não
// depende de web/dist, então ela é trocada antes de carregar o servidor:
//   ICLASS_TEST_BUILD=ok (padrão)  build considerado em dia;
//   ICLASS_TEST_BUILD=outdated     build desatualizado (a falha que o verifyBuild lança);
//   ICLASS_TEST_BUILD=real         a conferência de verdade.
const buildIntegrity = require('../../../backend/utils/buildIntegrity.js');

const mode = process.env.ICLASS_TEST_BUILD || 'ok';
if (mode === 'ok') {
    buildIntegrity.verifyBuild = () => ({});
} else if (mode === 'outdated') {
    buildIntegrity.verifyBuild = () => {
        const err = new Error('Build do frontend desatualizado. Execute npm run build novamente.');
        err.code = 'ICLASS_BUILD_OUTDATED';
        throw err;
    };
}

const { startServer } = require('../../../backend/server.js');

startServer({ port: Number(process.env.PORT || 0), host: '127.0.0.1' }).catch(err => {
    console.error(err);
    process.exit(1);
});
