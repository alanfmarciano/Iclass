// Carregado com node --require (NODE_OPTIONS) nos processos filhos dos testes de migração
// (A0, P6-S1): troca o registro de backend/migrations/index.js pelo do arquivo em
// ICLASS_TEST_MIGRATIONS ({ MIGRATIONS, BOOT_NORMALIZATIONS }). Pelo NODE_OPTIONS ele vale
// também nos filhos que a backup-cli abre (__conferir e __depois-de-restaurar).
if (process.env.ICLASS_TEST_MIGRATIONS) {
    const schemaMigrations = require('../../../backend/utils/schemaMigrations.js');
    schemaMigrations.useRegistryForTests(require(process.env.ICLASS_TEST_MIGRATIONS));
}
