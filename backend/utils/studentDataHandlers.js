// Ciclo de vida dos dados do aluno nas coleções novas (fundação C0b da fase 3; K14 do
// plano, contratos C5 do P1, C1 do P4, C6 do P5 e C7 do P3).
//
// Toda coleção nova que guarda dado de aluno (entregas de tarefa, grupos, conversas,
// contatos com responsáveis, histórico de matrícula, certificados novos...) registra
// aqui, no próprio módulo, o que fazer com o aluno em cada passo do ciclo de vida. Os
// pontos que já existem percorrem a lista DEPOIS dos blocos de hoje, sem mudar a saída
// de hoje (teste de igualdade em test/backend/igualdade-c0b.test.js; o resto do registro
// em test/backend/student-data-handlers.test.js):
// - troca de e-mail (renameStudentEmailEverywhere, admin.js): rename(memory, de, para);
// - anonimizar e apagar de vez (studentLifecycle.applyCascade): anonymize(memory, aluno,
//   pseudonimo) e purge(memory, aluno). Rodam depois dos blocos de hoje e antes da pasta
//   do aluno ir para a lixeira; se um handler lança erro, a memória volta inteira ao que
//   era antes do passo (nada fica pela metade) e o pedido é recusado. Por isso o handler
//   mexe só na memória. O que é em disco (arquivo de entrega para a lixeira, pacote de
//   curso excluído regravado, C10) o handler devolve como função (ou lista de funções;
//   null fica de fora): ela só roda depois que TODOS os handlers do passo deram certo e
//   a gravação do banco terminou (se a gravação falha, nada sai do lugar); erro numa
//   delas fica no crash.log e não desfaz o resto (a memória já está certa);
// - contagens (tela Cadastros encerrados, resposta e auditoria do anonimizar e do apagar,
//   studentLifecycle.recordCounts e closedStudentRows): count(memory, aluno) => número.
//   Com replaceCore, a contagem do handler substitui a de hoje com a mesma chave nos três
//   lugares (o B16 conta os certificados assim);
// - Meus dados (buildStudentDataExport, versões 'aluno' e 'admin'):
//   exportSection(memory, aluno, audience) => a seção (undefined deixa de fora). O arquivo
//   leva também extraSections ([{ key, label, columns }], só quando há seção nova), que a
//   versão para imprimir (web/src/lib/dataExportPrint.js) usa para mostrar a seção com o
//   nome em português; printColumns ([{ field, label, format: 'text'|'date'|'datetime'|
//   'grade'|'count' }]) escolhe as colunas da tabela impressa (sem ele, as chaves do
//   registro). A tela Cadastros encerrados recebe countLabels e mostra a contagem nova
//   com o label;
// - mesclar cadastros (mergeStudentRecords do P4-S4, depois da J3): merge(memory, fica,
//   sai), com a regra de colisão de mergeOwnedRecords;
// - religar depois de restaurar backup (ensureStudentIds do C1): relink(memory,
//   idsPorEmail) => true quando mudou algo; relinkRecordsByEmail faz o caso comum.
//
// 'aluno' (e 'fica' e 'sai') é o contexto de studentDataContext: { student (o cadastro
// como estava antes do passo), email (o atual, minúsculo), id (students[].id ou null),
// emails (todos os e-mails que ele já usou), owns(e-mail, registro, tipo) }. owns é o
// de studentEmailOwnership (gradebook.js), o mesmo da anonimização e de Meus dados:
// cada e-mail só no período em que foi do aluno. 'pseudonimo' é { ref, email, name }.
//
// Registro: registerStudentDataHandler({ collection, label, ...funções }) devolve a
// função que o retira (testes). collection é o nome da coleção (chave da seção de Meus
// dados e da contagem; exportKey troca a chave da seção) e label o nome em português
// ('Trabalhos entregues'). Chave que já é de uma seção ou contagem de hoje ('submissions',
// 'certificates'...) só com replaceCore: true (o B16 passa o certificado ao handler
// assim). Registrar de novo a mesma coleção troca o handler. As funções rodam na ordem
// de registro; erro num handler sobe (anonimizar sem limpar uma coleção não pode passar
// como feito).
const { studentEmailOwnership } = require('./gradebook.js');
const { normalizeEmail } = require('./students.js');

const HANDLER_FUNCTIONS = ['rename', 'anonymize', 'purge', 'merge', 'relink', 'count', 'exportSection'];
const PRINT_FORMATS = new Set(['text', 'date', 'datetime', 'grade', 'count']);

// Seções e contagens que já existem hoje (buildStudentDataExport, sectionCounts,
// recordCounts e closedStudentRows): handler só usa essas chaves com replaceCore.
const CORE_KEYS = new Set([
    'type', 'formatVersion', 'audience', 'generatedAt', 'notice', 'institution', 'generatedBy', 'knownEmails',
    'anonymized', 'profile', 'enrollments', 'acceptances', 'submissions', 'attendance', 'certificates',
    'observations', 'progress', 'notes', 'annotations', 'forum', 'moduleAccess', 'loginLogs', 'proctoring',
    'examRecords', 'examMessages', 'profileHistory', 'openAttempts', 'audit', 'examTitles', 'counts',
    'forumQuestions', 'forumReplies', 'proctoringLogs', 'keystrokes', 'extraSections',
]);

// Colunas da seção impressa: [{ field, label, format }] ou null.
function normalizePrintColumns(collection, columns) {
    if (columns === undefined || columns === null) return null;
    if (!Array.isArray(columns) || !columns.length) throw new TypeError(`studentDataHandlers: '${collection}.printColumns' precisa ser uma lista de colunas.`);
    return Object.freeze(columns.map(column => {
        const field = String((column && column.field) || '').trim();
        const label = String((column && column.label) || '').trim();
        const format = String((column && column.format) || 'text').trim();
        if (!field || !label) throw new TypeError(`studentDataHandlers: coluna de '${collection}.printColumns' sem field ou label.`);
        if (!PRINT_FORMATS.has(format)) throw new TypeError(`studentDataHandlers: formato '${format}' desconhecido em '${collection}.printColumns'.`);
        return Object.freeze({ field, label, format });
    }));
}

const handlers = new Map();

function registerStudentDataHandler(handler) {
    if (!handler || typeof handler !== 'object') throw new TypeError('studentDataHandlers: handler inválido.');
    const collection = String(handler.collection || '').trim();
    const label = String(handler.label || '').trim();
    if (!collection) throw new TypeError('studentDataHandlers: handler sem collection.');
    if (!label) throw new TypeError(`studentDataHandlers: handler '${collection}' sem label.`);
    HANDLER_FUNCTIONS.forEach(name => {
        if (handler[name] !== undefined && typeof handler[name] !== 'function') {
            throw new TypeError(`studentDataHandlers: '${collection}.${name}' precisa ser função.`);
        }
    });
    const exportKey = String(handler.exportKey || collection).trim();
    if (handler.replaceCore !== true) {
        if (handler.exportSection && CORE_KEYS.has(exportKey)) throw new TypeError(`studentDataHandlers: a seção '${exportKey}' já existe em Meus dados (use replaceCore).`);
        if (handler.count && CORE_KEYS.has(collection)) throw new TypeError(`studentDataHandlers: a contagem '${collection}' já existe (use replaceCore).`);
    }
    const printColumns = normalizePrintColumns(collection, handler.printColumns);
    const entry = Object.freeze({ ...handler, collection, label, exportKey, printColumns });
    handlers.set(collection, entry);
    return () => { if (handlers.get(collection) === entry) handlers.delete(collection); };
}

// Módulos que registram o handler da sua coleção ao carregar (cada grupo no próprio
// módulo). Entram na primeira consulta ao registro, e não só quando uma rota os carrega:
// assim todo caminho que percorre a lista tem todos os handlers, inclusive a backup-cli,
// que restaura sem as rotas e precisa religar as entregas (handler.relink, chamado por
// ensureStudentIds) na mesma passada da restauração. Carga na hora da consulta (não no
// topo) porque esses módulos dependem deste e de database.js.
const HANDLER_MODULES = Object.freeze(['./assignmentLifecycle.js']);
let handlerModulesLoaded = false;
function loadHandlerModules() {
    if (handlerModulesLoaded) return;
    handlerModulesLoaded = true;
    HANDLER_MODULES.forEach(name => require(name));
}

function studentDataHandlers() {
    loadHandlerModules();
    return [...handlers.values()];
}

function withFunction(name) {
    return studentDataHandlers().filter(handler => typeof handler[name] === 'function');
}

function hasStudentDataHandlers(name) {
    return name ? withFunction(name).length > 0 : studentDataHandlers().length > 0;
}

// Contexto do aluno para os handlers a partir do cadastro e da posse dos e-mails.
function studentContextFrom(student, ownership) {
    const record = student && typeof student === 'object' ? student : {};
    const own = ownership && typeof ownership.owns === 'function' ? ownership : { emails: [], owns: () => false };
    return Object.freeze({
        student: record,
        email: normalizeEmail(record.email),
        id: typeof record.id === 'string' && record.id ? record.id : null,
        emails: [...own.emails],
        owns: own.owns,
    });
}

// Contexto do aluno pelo cadastro ou pelo e-mail (null se o e-mail não é de aluno).
function studentDataContext(memory, studentOrEmail) {
    const email = normalizeEmail(typeof studentOrEmail === 'string' ? studentOrEmail : studentOrEmail && studentOrEmail.email);
    if (!email) return null;
    const student = typeof studentOrEmail === 'object' && studentOrEmail
        ? studentOrEmail
        : ((memory && memory.students) || []).find(item => item && normalizeEmail(item.email) === email);
    if (!student) return null;
    return studentContextFrom(student, studentEmailOwnership(memory, email));
}

// ------------------------------------------------------------ os passos
function renameStudentData(memory, oldEmail, newEmail) {
    const de = normalizeEmail(oldEmail);
    const para = normalizeEmail(newEmail);
    if (!de || !para || de === para) return;
    withFunction('rename').forEach(handler => handler.rename(memory, de, para));
}

// O que o handler devolveu para rodar depois (efeitos em disco): uma função ou uma
// lista delas; o resto é ignorado (o handler que não devolve nada continua valendo).
function deferredEffects(result) {
    const items = Array.isArray(result) ? result : [result];
    return items.filter(item => typeof item === 'function');
}

// Anonimizar e apagar de vez devolvem as funções que os handlers deixaram para depois
// (applyCascade roda todas quando o passo inteiro deu certo; ver o começo do arquivo).
function anonymizeStudentData(memory, aluno, pseudonimo) {
    const effects = [];
    withFunction('anonymize').forEach(handler => effects.push(...deferredEffects(handler.anonymize(memory, aluno, pseudonimo))));
    return effects;
}

function purgeStudentData(memory, aluno) {
    const effects = [];
    withFunction('purge').forEach(handler => effects.push(...deferredEffects(handler.purge(memory, aluno))));
    return effects;
}

function mergeStudentData(memory, fica, sai) {
    withFunction('merge').forEach(handler => handler.merge(memory, fica, sai));
}

// Mapa e-mail -> id (Map ou objeto) com e-mails minúsculos.
function idsByEmailMap(idsPorEmail) {
    const out = new Map();
    const entries = idsPorEmail instanceof Map ? [...idsPorEmail.entries()] : Object.entries(idsPorEmail || {});
    entries.forEach(([email, id]) => {
        const key = normalizeEmail(email);
        if (key && typeof id === 'string' && id) out.set(key, id);
    });
    return out;
}

function relinkStudentData(memory, idsPorEmail) {
    const map = idsByEmailMap(idsPorEmail);
    let changed = false;
    withFunction('relink').forEach(handler => { if (handler.relink(memory, map)) changed = true; });
    return changed;
}

// { [collection]: número } dos handlers que contam (sem handler, objeto vazio).
function countStudentData(memory, aluno) {
    const out = {};
    withFunction('count').forEach(handler => {
        const value = Number(handler.count(memory, aluno));
        out[handler.collection] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    });
    return out;
}

// { [exportKey]: seção } das seções de Meus dados dos handlers (undefined fica de fora).
function exportStudentDataSections(memory, aluno, audience) {
    const out = {};
    withFunction('exportSection').forEach(handler => {
        const section = handler.exportSection(memory, aluno, audience);
        if (section !== undefined) out[handler.exportKey] = section;
    });
    return out;
}

// { [collection]: label } dos handlers que contam (a tela Cadastros encerrados mostra a
// contagem nova com este nome). Contagem de hoje trocada por replaceCore já tem nome na
// tela e fica de fora.
function studentDataCountLabels() {
    const out = {};
    withFunction('count').forEach(handler => {
        if (!CORE_KEYS.has(handler.collection)) out[handler.collection] = handler.label;
    });
    return out;
}

// [{ key, label, columns }] das seções novas de Meus dados que estão em sections (o que
// exportStudentDataSections devolveu), na ordem de registro. Seção de hoje trocada por
// replaceCore já tem lugar na impressão e fica de fora.
function studentDataSectionsMeta(sections) {
    const present = sections && typeof sections === 'object' ? sections : {};
    return withFunction('exportSection')
        .filter(handler => Object.prototype.hasOwnProperty.call(present, handler.exportKey) && !CORE_KEYS.has(handler.exportKey))
        .map(handler => ({ key: handler.exportKey, label: handler.label, columns: handler.printColumns ? handler.printColumns.map(column => ({ ...column })) : null }));
}

// ------------------------------------------------------------ ajudas para os handlers
// Religa pelo e-mail o registro cujo studentId não é de nenhum aluno de hoje (backup
// antigo, aluno recriado) e cujo e-mail é de um aluno: o registro passa a ter o id dele.
// Registro sem studentId (gravado antes do C1) também ganha o id. Devolve true se mudou.
function relinkRecordsByEmail(memory, records, idsPorEmail, { emailField = 'studentEmail', idField = 'studentId' } = {}) {
    const map = idsPorEmail instanceof Map ? idsPorEmail : idsByEmailMap(idsPorEmail);
    const known = new Set(((memory && memory.students) || []).map(student => student && student.id).filter(Boolean));
    let changed = false;
    (Array.isArray(records) ? records : []).forEach(record => {
        if (!record || typeof record !== 'object') return;
        const current = record[idField];
        if (typeof current === 'string' && current && known.has(current)) return;
        const id = map.get(normalizeEmail(record[emailField]));
        if (!id || id === current) return;
        record[idField] = id;
        changed = true;
    });
    return changed;
}

// Regra de colisão da mesclagem (contrato de studentDataHandlers no plano). Percorre a
// lista de uma coleção e passa para o 'fica' os registros do 'sai':
// - registro do 'sai' sem chave composta ou sem par no 'fica': muda de dono (reassign);
// - 'fica' e 'sai' com a mesma chave (keyOf: entrega na mesma tarefa), coleção com
//   versões (versions: { field, orderBy, number }): não nasce linha repetida; as versões
//   do 'sai' entram ANTES das do 'fica', como versões anteriores, entre si na ordem de
//   orderBy (requestAt), e as do 'fica' continuam na ordem delas, por último, mesmo que
//   uma versão do 'sai' seja mais nova: a versão atual da entrega continua a do 'fica',
//   a que recebeu a nota dele. Todas são renumeradas em number (n) a partir de 1; o
//   resto do registro do 'fica' (a nota, a devolução) vale, e ele ganha mergedFrom; o do
//   'sai' sai da lista (o que só ele tinha fica no mergedFrom, por summary). Se o
//   próprio 'sai' tinha duas entregas na mesma tarefa, todas as versões dele (das duas)
//   vão juntas por orderBy, antes das do 'fica' (se o 'fica' tiver entrega nessa tarefa)
//   ou sozinhas (se não tiver);
// - mesma chave em coleção sem versões: o registro do 'sai' muda de dono e fica
//   arquivado (archive) com mergedFrom.
// mergedFrom é uma lista de { studentEmail, studentId, recordId, at, ...summary(sai) }.
// Muda os registros no lugar e devolve { records (a lista nova), moved, joined,
// archived }; o handler grava records de volta na coleção.
function mergeOwnedRecords(records, {
    isFica,
    isSai,
    keyOf = () => null,
    reassign,
    versions = null,
    archive = (record, when) => { record.archived = true; record.archivedAt = record.archivedAt || when; },
    summary = () => ({}),
    origin = {},
    at = Date.now(),
} = {}) {
    if (typeof isFica !== 'function' || typeof isSai !== 'function' || typeof reassign !== 'function') {
        throw new TypeError('mergeOwnedRecords: isFica, isSai e reassign são obrigatórios.');
    }
    const list = Array.isArray(records) ? records : [];
    const ficaByKey = new Map();
    const keyFor = record => {
        const key = keyOf(record);
        return key === undefined || key === null || key === '' ? null : String(key);
    };
    list.forEach(record => {
        if (!record || !isFica(record)) return;
        const key = keyFor(record);
        if (key !== null && !ficaByKey.has(key)) ficaByKey.set(key, record);
    });
    const mergedEntry = record => ({
        studentEmail: normalizeEmail(origin.studentEmail) || null,
        studentId: origin.studentId || null,
        recordId: record && record.id !== undefined ? record.id : null,
        at,
        ...(summary(record) || {}),
    });
    const addMergedFrom = (target, source) => {
        target.mergedFrom = [...(Array.isArray(target.mergedFrom) ? target.mergedFrom : []), mergedEntry(source)];
    };
    const dropped = new Set();
    const movedFromSai = new Set();
    // Por registro que recebe versões: as do 'sai' juntadas até agora e as do próprio
    // 'fica' (vazias quando o registro também veio do 'sai'). A cada junção a lista é
    // refeita inteira: todas as do 'sai' por orderBy, depois as do 'fica' na ordem delas.
    const versionParts = new Map();
    let moved = 0;
    let joined = 0;
    let archived = 0;
    list.forEach(record => {
        if (!record || isFica(record) || !isSai(record)) return;
        const key = keyFor(record);
        const pair = key === null ? null : ficaByKey.get(key);
        if (!pair) {
            reassign(record);
            if (key !== null) { ficaByKey.set(key, record); movedFromSai.add(record); }
            moved++;
            return;
        }
        if (versions && versions.field) {
            const field = versions.field;
            const orderBy = versions.orderBy || 'requestAt';
            const order = item => {
                const value = item && item[orderBy];
                const number = typeof value === 'number' ? value : Date.parse(value);
                return Number.isFinite(number) ? number : 0;
            };
            const byOrder = items => items
                .map((item, index) => ({ item, index }))
                .sort((a, b) => order(a.item) - order(b.item) || a.index - b.index)
                .map(({ item }) => item);
            const own = Array.isArray(record[field]) ? record[field] : [];
            if (!versionParts.has(pair)) {
                const current = Array.isArray(pair[field]) ? pair[field] : [];
                // Par que também veio do 'sai' (o 'sai' já tinha duas entregas na mesma
                // tarefa): nenhuma versão é do 'fica'.
                versionParts.set(pair, movedFromSai.has(pair) ? { sai: [...current], fica: [] } : { sai: [], fica: [...current] });
            }
            const parts = versionParts.get(pair);
            parts.sai.push(...own);
            const combined = [...byOrder(parts.sai), ...parts.fica];
            if (versions.number) combined.forEach((item, index) => { if (item && typeof item === 'object') item[versions.number] = index + 1; });
            pair[field] = combined;
            addMergedFrom(pair, record);
            dropped.add(record);
            joined++;
            return;
        }
        reassign(record);
        archive(record, at);
        addMergedFrom(record, record);
        archived++;
    });
    return { records: dropped.size ? list.filter(record => !dropped.has(record)) : list, moved, joined, archived };
}

module.exports = {
    CORE_KEYS,
    registerStudentDataHandler,
    studentDataHandlers,
    hasStudentDataHandlers,
    studentContextFrom,
    studentDataContext,
    renameStudentData,
    anonymizeStudentData,
    purgeStudentData,
    mergeStudentData,
    relinkStudentData,
    countStudentData,
    exportStudentDataSections,
    studentDataCountLabels,
    studentDataSectionsMeta,
    relinkRecordsByEmail,
    mergeOwnedRecords,
};
