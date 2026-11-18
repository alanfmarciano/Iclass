// Registro de migrações dos dados (fase 3, A0 / P6-S1: CONF-16, OPS-02, ENG-14).
//
// Toda conversão de dado que já existe no banco, a partir da fase 3, é uma linha desta
// lista, na ordem em que roda. O executor (backend/utils/schemaMigrations.js) compara a
// lista com schemaMeta.aplicadas (tabela schema_meta) e roda só o que falta:
// - no boot (database.js init): depois de um backup 'pre-atualizacao' conferido, todas as
//   que faltam, na ordem, e uma gravação só no fim;
// - depois de restaurar um backup (gancho 'schemaMigrations', o primeiro de
//   AFTER_RESTORE_HOOKS em database.js, na tela Sistema e na backup-cli): as de memória
//   que faltam ao backup.
//
// Cada linha: { id, nome, tipo, run }.
// - id: 'AAAA-MM-<grupo>-<nome>' (ex.: '2026-11-p4-ids-alunos'), texto estável, nunca um
//   número (dois ramos em paralelo não disputam o mesmo número);
// - nome: o que a migração faz, em português (aparece no console e no erro);
// - tipo 'memoria': run(memory, ctx) é uma função pura sobre a memória, idempotente, sem
//   gravar (db.save lança erro enquanto ela roda) e sem ler arquivo; devolve true se mudou
//   alguma coisa. ctx: { origem: 'boot' | 'restauracao', now, versaoApp,
//   previousStudentIds } (previousStudentIds: Map e-mail em minúsculas -> id do aluno,
//   lido da memória de antes da restauração; vazio no boot);
// - tipo 'sql': run(sql) para as tabelas próprias (kind 'store', fora da memória), com
//   sql.run(texto, parâmetros), sql.get e sql.all numa transação dentro da fila de
//   gravação. Só roda no boot (depois de restaurar, fica para o boot seguinte).
//
// Regras (shared_contracts da fase 3):
// - linha que já está no main é IMUTÁVEL: efeito novo é uma linha nova com id novo. O teste
//   test/backend/schema-migrations.test.js confere o código de cada uma pelo hash gravado
//   em test/backend/fixtures/migracoes-publicadas.json (quem acrescenta uma linha
//   acrescenta o hash dela lá; nunca apague nem troque uma linha daquele arquivo);
// - coleção nova vazia não precisa de migração (CREATE TABLE IF NOT EXISTS do registro de
//   tabelas) e leitura tolerante com padrão para campo ausente não precisa de migração;
// - este arquivo e o que ele carrega não dependem de database.js: a backup-cli lê a lista
//   (para recusar backup de versão mais nova) com o servidor parado.
//
// BOOT_NORMALIZATIONS: conversões que valem em TODO boot e depois de TODA restauração
// (tela e backup-cli), porque a versão 281029f não recusa um banco migrado e pode gravar
// dado no formato antigo depois da migração (o Alan volta de versão, abre a pasta antiga).
// Cada item: { id, nome, run(memory, ctx) => boolean }, idempotente; grava só se mudou. A
// primeira será ensureStudentIds (P4-S3, trilha C). As normalizações antigas do init
// (contas, senhas, studentClass, provas resetadas) continuam onde estão (D2 do P6).

const MIGRATIONS = Object.freeze([
    Object.freeze({
        id: '2026-11-p6-base',
        nome: 'Marca a base 281029f (não muda nenhum dado)',
        tipo: 'memoria',
        run() {
            return false;
        },
    }),
]);

const BOOT_NORMALIZATIONS = Object.freeze([]);

module.exports = { MIGRATIONS, BOOT_NORMALIZATIONS };
