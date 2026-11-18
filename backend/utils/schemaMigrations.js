// Executor das migrações dos dados (fase 3, A0 / P6-S1: CONF-16, OPS-02, ENG-14).
//
// O registro (a lista das migrações e das normalizações de todo boot) fica em
// backend/migrations/index.js; o estado, na coleção schemaMeta (tabela schema_meta, linha
// 'default'):
//   { aplicadas: [{ id, em, versaoApp, naRestauracao? }] na ordem do registro,
//     atualizacoes: [{ de, para, em, migracoes: [ids], backup, semBackup, instalacaoNova? }]
//     (as 20 últimas), versaoApp: a última versão do IClass que abriu este banco }.
// PRAGMA user_version espelha a quantidade de aplicadas (só informação).
//
// - planSchema(valor): o que falta (pending), o que este código não conhece (unknown) e o
//   que já foi aplicado, a partir do schemaMeta de um banco ou do campo esquema do
//   manifesto de um backup ({ aplicadas: [ids], versaoApp }). Sem nada: base 281029f.
// - applyOnBoot: as que faltam no boot, as normalizações e o registro da atualização
//   (atualizacoes, auditoria app_updated e backup_preupdate_*), sem gravar: quem chama
//   (database.js init) grava uma vez no fim;
// - afterRestore: o gancho 'schemaMigrations' (o primeiro de AFTER_RESTORE_HOOKS), que roda
//   sobre a memória restaurada as migrações de memória que faltam ao backup, as
//   normalizações e deixa schemaMeta com a lista completa;
// - readSchemaMetaOn / readSchemaMetaFile: leitura direta da tabela (antes de qualquer
//   gravação do boot, na backup-cli e no manifesto do backup).
//
// Este módulo não depende de database.js (a backup-cli o usa com o servidor parado).
const crypto = require('crypto');
const dbFile = require('./dbFile.js');
const { recordAudit } = require('./audit.js');

const SCHEMA_COLLECTION = 'schemaMeta';
const SCHEMA_TABLE = 'schema_meta';
const SCHEMA_KEY = 'default';
const MAX_UPDATES = 20;
const MIGRATION_ID = /^\d{4}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)+$/;
const MIGRATION_TYPES = new Set(['memoria', 'sql']);

function appVersion() {
    try { return String(require('../../package.json').version || ''); } catch (e) { return ''; }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// --- registro --------------------------------------------------------------------------

function registryError(message) {
    return new TypeError(`Registro de migrações inválido: ${message}`);
}

// Confere o registro uma vez (ids no formato, únicos, tipo conhecido, run função).
function validateRegistry({ migrations, normalizations = [] } = {}) {
    if (!Array.isArray(migrations)) throw registryError('MIGRATIONS precisa ser uma lista.');
    if (!Array.isArray(normalizations)) throw registryError('BOOT_NORMALIZATIONS precisa ser uma lista.');
    const seen = new Set();
    const checkId = (id, where) => {
        if (typeof id !== 'string' || !MIGRATION_ID.test(id)) throw registryError(`id "${id}" fora do formato AAAA-MM-<grupo>-<nome> (${where}).`);
        if (seen.has(id)) throw registryError(`id repetido "${id}".`);
        seen.add(id);
    };
    migrations.forEach((row, index) => {
        if (!isPlainObject(row)) throw registryError(`a linha ${index + 1} não é um objeto.`);
        checkId(row.id, 'MIGRATIONS');
        if (typeof row.nome !== 'string' || !row.nome.trim()) throw registryError(`a migração ${row.id} não tem nome.`);
        if (!MIGRATION_TYPES.has(row.tipo)) throw registryError(`a migração ${row.id} tem tipo "${row.tipo}" (use "memoria" ou "sql").`);
        if (typeof row.run !== 'function') throw registryError(`a migração ${row.id} não tem run.`);
    });
    normalizations.forEach((row, index) => {
        if (!isPlainObject(row)) throw registryError(`a normalização ${index + 1} não é um objeto.`);
        checkId(row.id, 'BOOT_NORMALIZATIONS');
        if (typeof row.nome !== 'string' || !row.nome.trim()) throw registryError(`a normalização ${row.id} não tem nome.`);
        if (typeof row.run !== 'function') throw registryError(`a normalização ${row.id} não tem run.`);
    });
    return Object.freeze({ migrations: Object.freeze([...migrations]), normalizations: Object.freeze([...normalizations]) });
}

let defaultRegistry = null;
let registryOverride = null;

function registry() {
    if (registryOverride) return registryOverride;
    if (!defaultRegistry) {
        const loaded = require('../migrations/index.js');
        defaultRegistry = validateRegistry({ migrations: loaded.MIGRATIONS, normalizations: loaded.BOOT_NORMALIZATIONS });
    }
    return defaultRegistry;
}

// Só para os testes: troca o registro (null volta ao de backend/migrations/index.js).
// Aceita { migrations, normalizations } ou o formato do módulo ({ MIGRATIONS,
// BOOT_NORMALIZATIONS }).
function useRegistryForTests(value) {
    if (!value) {
        registryOverride = null;
        return;
    }
    registryOverride = validateRegistry(Array.isArray(value.MIGRATIONS)
        ? { migrations: value.MIGRATIONS, normalizations: value.BOOT_NORMALIZATIONS || [] }
        : value);
}

// Hash do código de uma migração (teste de imutabilidade das publicadas). Fim de linha
// normalizado: um checkout no Windows com CRLF não muda o hash.
function migrationHash(row) {
    const code = String(row.run).replace(/\r\n?/g, '\n');
    return crypto.createHash('sha256').update(`${row.id}\n${row.tipo}\n${code}`).digest('hex');
}

// --- estado (schemaMeta) ---------------------------------------------------------------

function emptySchemaMeta() {
    return { aplicadas: [], atualizacoes: [] };
}

// Entradas aplicadas de um schemaMeta ou de um esquema de manifesto (lista de ids).
function appliedEntries(value) {
    const list = isPlainObject(value) && Array.isArray(value.aplicadas) ? value.aplicadas : (Array.isArray(value) ? value : []);
    const seen = new Set();
    const entries = [];
    list.forEach(item => {
        const entry = typeof item === 'string' ? { id: item } : (isPlainObject(item) && typeof item.id === 'string' ? { ...item } : null);
        if (!entry || !entry.id.trim() || seen.has(entry.id)) return;
        seen.add(entry.id);
        entries.push(entry);
    });
    return entries;
}

function appliedIds(value) {
    return appliedEntries(value).map(entry => entry.id);
}

// Leitura tolerante: campo que falta vale o padrão (banco ou backup editado à mão).
function normalizeSchemaMeta(value) {
    const source = isPlainObject(value) ? value : {};
    const meta = { ...source, aplicadas: appliedEntries(source), atualizacoes: Array.isArray(source.atualizacoes) ? source.atualizacoes.filter(isPlainObject) : [] };
    if (typeof source.versaoApp !== 'string') delete meta.versaoApp;
    return meta;
}

function dataVersion(value) {
    return isPlainObject(value) && typeof value.versaoApp === 'string' && value.versaoApp ? value.versaoApp : null;
}

// O que falta e o que este código não conhece. value: schemaMeta, esquema do manifesto ou
// nada (base 281029f).
function planSchema(value, reg = registry()) {
    const applied = appliedIds(value);
    const appliedSet = new Set(applied);
    const known = new Set(reg.migrations.map(row => row.id));
    return {
        applied,
        pending: reg.migrations.filter(row => !appliedSet.has(row.id)),
        unknown: applied.filter(id => !known.has(id)),
        versaoApp: dataVersion(value),
    };
}

// Campo esquema do manifesto do backup ZIP formato 2 (aditivo; o formato continua 2).
function manifestSchema(value) {
    return { aplicadas: appliedIds(value), versaoApp: dataVersion(value) };
}

// Ordem do registro; ids desconhecidos (banco de versão mais nova aberto em TEST_MODE)
// ficam no fim, como vieram.
function sortApplied(entries, reg = registry()) {
    const order = new Map(reg.migrations.map((row, index) => [row.id, index]));
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
            const ia = order.has(a.entry.id) ? order.get(a.entry.id) : Number.MAX_SAFE_INTEGER;
            const ib = order.has(b.entry.id) ? order.get(b.entry.id) : Number.MAX_SAFE_INTEGER;
            return ia - ib || a.index - b.index;
        })
        .map(item => item.entry);
}

// --- recusas ---------------------------------------------------------------------------

function newerLabel(version) {
    return version ? `pela versão ${version} do IClass, mais nova que esta (${appVersion() || 'atual'})` : `por uma versão mais nova do IClass que esta (${appVersion() || 'atual'})`;
}

// Banco aberto por uma versão mais nova (D5 do P6, só da 3.1 em diante): saída 2.
function newerDatabaseError(plan) {
    const message = `Estes dados foram atualizados ${newerLabel(plan.versaoApp)}. Abra a versão nova, ou use "Voltar para a versão anterior" no menu para restaurar o backup de antes da atualização.`;
    return Object.assign(new Error(message), { code: 'ICLASS_SCHEMA_NEWER', unknownMigrations: plan.unknown.slice() });
}

// Backup feito por uma versão mais nova: 400 em português, nada muda.
function newerBackupRefusal(value) {
    const plan = planSchema(value);
    const message = `Este backup foi feito ${newerLabel(plan.versaoApp)}. Atualize este IClass antes de restaurar.`;
    return Object.assign(new Error(message), { status: 400, code: 'backup_schema_newer', unknownMigrations: plan.unknown.slice() });
}

function assertBackupSchemaKnown(value) {
    if (value === undefined || value === null) return;
    if (planSchema(value).unknown.length) throw newerBackupRefusal(value);
}

// --- leitura direta ----------------------------------------------------------------------

// { table: a tabela existe, value: o schemaMeta lido (null sem linha), unreadable }.
async function readSchemaMetaOn(connection) {
    const tables = await dbFile.tableNames(connection);
    if (!tables.includes(SCHEMA_TABLE)) return { table: false, value: null, unreadable: false };
    const row = await dbFile.getOn(connection, `SELECT value FROM ${SCHEMA_TABLE} WHERE key = ?`, [SCHEMA_KEY]);
    if (!row) return { table: true, value: null, unreadable: false };
    try {
        const value = JSON.parse(row.value);
        return { table: true, value: isPlainObject(value) ? value : null, unreadable: !isPlainObject(value) };
    } catch (e) {
        return { table: true, value: null, unreadable: true };
    }
}

async function readSchemaMetaFile(file) {
    const connection = await dbFile.openDatabaseFile(file, { readOnly: true });
    try {
        return await readSchemaMetaOn(connection);
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
}

// --- execução ----------------------------------------------------------------------------

function migrationFailure(row, cause, kind = 'etapa') {
    const detail = (cause && cause.message) || String(cause);
    const err = new Error(`A atualização dos dados parou na ${kind} "${row.nome}" (${row.id}): ${detail}`);
    return Object.assign(err, { code: 'ICLASS_MIGRATION_FAILED', migrationId: row.id, migrationName: row.nome, cause });
}

// A de memória é síncrona: uma promessa devolvida deixaria a trava do db.save aberta para
// outros pedidos no meio (e não há I/O a esperar numa função pura).
function runSync(row, memory, ctx) {
    const result = row.run(memory, ctx);
    if (result && typeof result.then === 'function') {
        result.then(() => {}, () => {});
        throw new Error('a função precisa ser síncrona (devolveu uma promessa).');
    }
    return result;
}

// Roda as linhas na ordem. guard(row, fn): fn com db.save bloqueado (database.js);
// runSql(row): a de tipo 'sql' numa transação (sem runSql, a 'sql' fica para o boot).
async function runMigrationRows(memory, rows, ctx, { guard = (row, fn) => fn(), runSql = null } = {}) {
    const ran = [];
    for (const row of rows) {
        let changed;
        try {
            if (row.tipo === 'sql') {
                if (!runSql) continue;
                changed = await runSql(row);
            } else {
                changed = guard(row, () => runSync(row, memory, ctx));
            }
        } catch (err) {
            throw migrationFailure(row, err);
        }
        ran.push({ id: row.id, nome: row.nome, tipo: row.tipo, changed: changed === true });
    }
    return ran;
}

async function runNormalizations(memory, ctx, { guard = (row, fn) => fn(), reg = registry() } = {}) {
    let changed = false;
    for (const row of reg.normalizations) {
        try {
            if (guard(row, () => runSync(row, memory, ctx)) === true) changed = true;
        } catch (err) {
            throw migrationFailure(row, err, 'normalização');
        }
    }
    return changed;
}

function idsMap(value) {
    if (value instanceof Map) return value;
    const map = new Map();
    if (isPlainObject(value)) Object.entries(value).forEach(([email, id]) => map.set(String(email).toLowerCase(), id));
    return map;
}

// Boot: as migrações que faltam (plan.pending, na ordem), as normalizações e o registro
// da atualização na memória. Não grava. Devolve { changed, ran, updated, entry }.
// bancoNovo: instalação nova (nenhuma tabela antes do boot): sem auditoria de atualização.
// preUpdate: o resultado do backup 'pre-atualizacao' ({ arquivo, bytes, sha256,
// destinoExterno } ou { skipped, motivo }) ou null.
async function applyOnBoot(memory, { plan, now = Date.now(), guard, runSql, bancoNovo = false, preUpdate = null, startedAt = now, reg = registry() } = {}) {
    const versaoApp = appVersion();
    const ctx = { origem: 'boot', now, versaoApp, previousStudentIds: new Map() };
    const ran = await runMigrationRows(memory, plan.pending, ctx, { guard, runSql });
    const normalized = await runNormalizations(memory, ctx, { guard, reg });
    const meta = normalizeSchemaMeta(memory[SCHEMA_COLLECTION]);
    const de = dataVersion(meta);
    const updated = ran.length > 0 || de !== versaoApp;
    let entry = null;
    if (updated) {
        const known = new Map(meta.aplicadas.map(item => [item.id, item]));
        ran.forEach(item => { if (!known.has(item.id)) known.set(item.id, { id: item.id, em: now, versaoApp }); });
        meta.aplicadas = sortApplied([...known.values()], reg);
        meta.versaoApp = versaoApp;
        entry = {
            de,
            para: versaoApp,
            em: now,
            migracoes: ran.map(item => item.id),
            backup: preUpdate && preUpdate.arquivo ? preUpdate.arquivo : null,
            semBackup: !!(preUpdate && preUpdate.skipped),
            ...(bancoNovo ? { instalacaoNova: true } : {}),
        };
        meta.atualizacoes = [...meta.atualizacoes, entry].slice(-MAX_UPDATES);
        memory[SCHEMA_COLLECTION] = meta;
        if (!bancoNovo) {
            if (preUpdate && preUpdate.arquivo) {
                recordAudit(memory, {
                    actor: 'sistema',
                    action: 'backup_preupdate_created',
                    category: 'backup',
                    details: { arquivo: preUpdate.arquivo, bytes: preUpdate.bytes, sha256: preUpdate.sha256, destinoExterno: !!preUpdate.destinoExterno },
                });
            } else if (preUpdate && preUpdate.skipped) {
                recordAudit(memory, {
                    actor: 'sistema',
                    action: 'backup_preupdate_skipped',
                    category: 'backup',
                    details: { de, para: versaoApp, motivo: preUpdate.motivo || 'pedido no launcher' },
                });
            }
            recordAudit(memory, {
                actor: 'sistema',
                action: 'app_updated',
                category: 'system',
                details: { de, para: versaoApp, migracoes: entry.migracoes, backup: entry.backup, duracaoMs: Math.max(0, Date.now() - startedAt) },
            });
        }
    }
    return { changed: updated || normalized || ran.some(item => item.changed), ran, updated, entry };
}

// Gancho 'schemaMigrations' (o primeiro de AFTER_RESTORE_HOOKS). context:
// - backupSchema: o schemaMeta do backup (ou o esquema do manifesto); undefined: base;
// - previousSchemaMeta: o schemaMeta desta instalação lido antes do laço (fica o histórico
//   de atualizações dela; as aplicadas passam a ser as do backup mais as que rodaram);
// - previousStudentIds: Map e-mail -> id dos alunos de antes da restauração (as
//   normalizações reaproveitam o id do mesmo e-mail quando o backup não traz);
// - exact: a volta exata ao estado de antes (restauração que falhou): nada roda.
// As de tipo 'sql' ficam para o boot seguinte (pendentes). Devolve { ran }.
async function afterRestore(memory, context = {}, { guard, reg = registry() } = {}) {
    if (context.exact) return { ran: [] };
    const plan = planSchema(context.backupSchema, reg);
    if (plan.unknown.length) throw newerBackupRefusal(context.backupSchema);
    const versaoApp = appVersion();
    const now = Date.now();
    const ctx = { origem: 'restauracao', now, versaoApp, previousStudentIds: idsMap(context.previousStudentIds) };
    const ran = await runMigrationRows(memory, plan.pending.filter(row => row.tipo === 'memoria'), ctx, { guard });
    await runNormalizations(memory, ctx, { guard, reg });
    const current = normalizeSchemaMeta(context.previousSchemaMeta !== undefined ? context.previousSchemaMeta : memory[SCHEMA_COLLECTION]);
    const fromBackup = appliedEntries(context.backupSchema);
    const entries = [...fromBackup, ...ran.map(item => ({ id: item.id, em: now, versaoApp, naRestauracao: true }))];
    memory[SCHEMA_COLLECTION] = { ...current, aplicadas: sortApplied(entries, reg), versaoApp };
    if (ran.length) {
        recordAudit(memory, {
            actor: 'sistema',
            action: 'schema_migrated_on_restore',
            category: 'backup',
            details: { migracoes: ran.map(item => item.id), de: fromBackup.length ? fromBackup[fromBackup.length - 1].id : 'base' },
        });
    }
    return { ran };
}

module.exports = {
    MAX_UPDATES,
    MIGRATION_ID,
    SCHEMA_COLLECTION,
    SCHEMA_KEY,
    SCHEMA_TABLE,
    afterRestore,
    appVersion,
    appliedIds,
    applyOnBoot,
    assertBackupSchemaKnown,
    emptySchemaMeta,
    manifestSchema,
    migrationHash,
    newerBackupRefusal,
    newerDatabaseError,
    normalizeSchemaMeta,
    planSchema,
    readSchemaMetaFile,
    readSchemaMetaOn,
    registry,
    runMigrationRows,
    runNormalizations,
    sortApplied,
    useRegistryForTests,
    validateRegistry,
};
