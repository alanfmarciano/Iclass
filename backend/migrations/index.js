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
// primeira será ensureStudentIds (P4-S3, trilha C); a da identidade da instalação (A1) vem
// depois dela. As normalizações antigas do init
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
    // Identidade desta instalação (A1 / P6-S2: OPS-21, OPS-02): settings.install.id (UUID)
    // e criadaEm (ms), quando faltam. Só isso: licenciadoPara e a licença são de outras
    // subetapas (A21b), e o 'setup migrado' é a linha '2026-11-p6-setup-migrado' (A20). No
    // banco que já existia, criadaEm é o momento desta migração (não há data de instalação
    // gravada antes). Depois de restaurar um backup sem a seção, ela roda sobre o que foi
    // restaurado, e o gancho 'protectedConfig' põe de volta a identidade de agora (um
    // backup de outro computador não troca a identidade desta instalação).
    Object.freeze({
        id: '2026-11-p6-instalacao',
        nome: 'Dá um código e a data de criação a esta instalação',
        tipo: 'memoria',
        run(memory, ctx) {
            const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
            if (!isObject(memory.config)) memory.config = {};
            if (!isObject(memory.config.settings)) memory.config.settings = {};
            const settings = memory.config.settings;
            const install = isObject(settings.install) ? settings.install : {};
            let changed = !isObject(settings.install);
            if (typeof install.id !== 'string' || !install.id.trim()) {
                install.id = require('crypto').randomUUID();
                changed = true;
            }
            if (!Number.isFinite(install.criadaEm) || install.criadaEm <= 0) {
                install.criadaEm = Number.isFinite(ctx && ctx.now) ? ctx.now : Date.now();
                changed = true;
            }
            settings.install = install;
            return changed;
        },
    }),
    // Token da prova fora do histórico (P3-S8: AVA-14; D19 do desenho do P3): a tela
    // Provas gravava o token em texto puro em cada configuração salva
    // (classes[].examHistory[prova][].accessToken), e GET /api/admin/exam-history o
    // devolvia. Agora a configuração guarda só se pede token (tokenEnabled: true quando
    // havia um token válido) e o token da aplicação fica selado nela. Idempotente: sem o
    // campo, nada a fazer.
    Object.freeze({
        id: '2026-11-p3-token-historico',
        nome: 'Tira o token da prova em texto puro do histórico das configurações salvas',
        tipo: 'memoria',
        run(memory) {
            let changed = false;
            (Array.isArray(memory.classes) ? memory.classes : []).forEach(cls => {
                const history = cls && typeof cls === 'object' && cls.examHistory && typeof cls.examHistory === 'object' && !Array.isArray(cls.examHistory)
                    ? cls.examHistory
                    : null;
                if (!history) return;
                Object.keys(history).forEach(examKey => {
                    (Array.isArray(history[examKey]) ? history[examKey] : []).forEach(entry => {
                        if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'accessToken')) return;
                        const hadToken = /^[A-Z]{5}$/.test(String(entry.accessToken || '').trim().toUpperCase());
                        entry.tokenEnabled = hadToken || entry.tokenEnabled === true;
                        delete entry.accessToken;
                        changed = true;
                    });
                });
            });
            return changed;
        },
    }),
]);

// Identidade da instalação em todo boot (A1 / P6-S2, rodada de ajuste): a versão 281029f
// não conhece settings.install e, ao salvar Configurações (mergeSettings só com as chaves
// dela), apaga a seção; ao restaurar um backup pela tela dela, a seção vem do backup (de
// outro computador, talvez). A linha '2026-11-p6-instalacao' roda uma vez só, então a
// conferência fica aqui. A cópia em schemaMeta.instalacao ({ id, criadaEm }) é a
// referência: a tabela schema_meta não existe para a 281029f, que nunca a lê nem grava, e
// a restauração mantém a desta instalação (schemaMeta tem restore 'keep'). Regra:
// - com a cópia: settings.install.id e criadaEm voltam a ser os dela (o resto da seção,
//   como a licença do A21b, fica como está);
// - sem a cópia (primeiro boot depois da migração): vale o que está em settings.install, e
//   o que faltar ganha um código novo e a data de agora, como na migração;
// - no fim, a cópia fica igual a settings.install. Idempotente: grava só se mudou.
function isPlainObjectValue(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validInstallId(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function validInstallTime(value) {
    return Number.isFinite(value) && value > 0;
}

function ensureInstallIdentity(memory, ctx) {
    let changed = false;
    if (!isPlainObjectValue(memory.config)) { memory.config = {}; changed = true; }
    if (!isPlainObjectValue(memory.config.settings)) { memory.config.settings = {}; changed = true; }
    const settings = memory.config.settings;
    if (!isPlainObjectValue(settings.install)) { settings.install = {}; changed = true; }
    const install = settings.install;
    if (!isPlainObjectValue(memory.schemaMeta)) { memory.schemaMeta = { aplicadas: [], atualizacoes: [] }; changed = true; }
    const meta = memory.schemaMeta;
    const copy = isPlainObjectValue(meta.instalacao) && validInstallId(meta.instalacao.id) && validInstallTime(meta.instalacao.criadaEm)
        ? meta.instalacao
        : null;
    if (copy) {
        if (install.id !== copy.id) { install.id = copy.id; changed = true; }
        if (install.criadaEm !== copy.criadaEm) { install.criadaEm = copy.criadaEm; changed = true; }
    } else {
        if (!validInstallId(install.id)) { install.id = require('crypto').randomUUID(); changed = true; }
        if (!validInstallTime(install.criadaEm)) {
            install.criadaEm = Number.isFinite(ctx && ctx.now) ? ctx.now : Date.now();
            changed = true;
        }
    }
    if (!copy || copy.id !== install.id || copy.criadaEm !== install.criadaEm || Object.keys(copy).length !== 2) {
        meta.instalacao = { id: install.id, criadaEm: install.criadaEm };
        changed = true;
    }
    return changed;
}

// Token da prova fora do histórico em todo boot (P3-S8: AVA-14, rodada de ajuste 2): a
// linha '2026-11-p3-token-historico' roda uma vez só, mas a versão 281029f, se abrir o
// banco depois da migração, volta a gravar o token em texto puro em
// classes[].examHistory[prova][].accessToken ao preparar uma prova pela tela Provas dela
// (e um backup feito nela o leva junto). A mesma limpeza fica aqui, para todo boot e depois
// de toda restauração: a entrada guarda só tokenEnabled (true quando havia um token de 5
// letras ou já estava true). Idempotente: sem o campo, nada muda e nada é gravado.
function stripPlainExamHistoryTokens(memory) {
    let changed = false;
    (Array.isArray(memory && memory.classes) ? memory.classes : []).forEach(cls => {
        const history = cls && typeof cls === 'object' && isPlainObjectValue(cls.examHistory) ? cls.examHistory : null;
        if (!history) return;
        Object.keys(history).forEach(examKey => {
            (Array.isArray(history[examKey]) ? history[examKey] : []).forEach(entry => {
                if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'accessToken')) return;
                const hadToken = /^[A-Z]{5}$/.test(String(entry.accessToken || '').trim().toUpperCase());
                entry.tokenEnabled = hadToken || entry.tokenEnabled === true;
                delete entry.accessToken;
                changed = true;
            });
        });
    });
    return changed;
}

const BOOT_NORMALIZATIONS = Object.freeze([
    Object.freeze({
        id: '2026-11-p6-instalacao-sempre',
        nome: 'Confere o código desta instalação',
        run(memory, ctx) {
            return ensureInstallIdentity(memory, ctx);
        },
    }),
    Object.freeze({
        id: '2026-11-p3-token-historico-sempre',
        nome: 'Confere que o histórico das configurações salvas não guarda o token da prova',
        run(memory) {
            return stripPlainExamHistoryTokens(memory);
        },
    }),
]);

module.exports = { MIGRATIONS, BOOT_NORMALIZATIONS, ensureInstallIdentity, stripPlainExamHistoryTokens };
