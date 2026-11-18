// Ciclo de vida dos dados do aluno nas coleções novas (fundação C0b da fase 3; K14 do
// plano, contratos C5 do P1, C1 do P4, C6 do P5 e C7 do P3).
//
// Toda coleção nova que guarda dado de aluno (entregas de tarefa, grupos, conversas,
// contatos com responsáveis, histórico de matrícula, certificados novos...) registra
// aqui, no próprio módulo, o que fazer com o aluno em cada passo do ciclo de vida. Os
// pontos que já existem percorrem a lista DEPOIS dos blocos de hoje, sem mudar a saída
// de hoje (teste de igualdade em test/backend/student-data-handlers.test.js):
// - troca de e-mail (renameStudentEmailEverywhere, admin.js): rename(memory, de, para);
// - anonimizar e apagar de vez (studentLifecycle.applyCascade): anonymize(memory, aluno,
//   pseudonimo) e purge(memory, aluno);
// - contagens (tela Cadastros encerrados, resposta e auditoria do anonimizar e do apagar,
//   studentLifecycle.recordCounts e closedStudentRows): count(memory, aluno) => número;
// - Meus dados (buildStudentDataExport, versões 'aluno' e 'admin'):
//   exportSection(memory, aluno, audience) => a seção (undefined deixa de fora);
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

// Seções e contagens que já existem hoje (buildStudentDataExport, sectionCounts,
// recordCounts e closedStudentRows): handler só usa essas chaves com replaceCore.
const CORE_KEYS = new Set([
    'type', 'formatVersion', 'audience', 'generatedAt', 'notice', 'institution', 'generatedBy', 'knownEmails',
    'anonymized', 'profile', 'enrollments', 'acceptances', 'submissions', 'attendance', 'certificates',
    'observations', 'progress', 'notes', 'annotations', 'forum', 'moduleAccess', 'loginLogs', 'proctoring',
    'examRecords', 'examMessages', 'profileHistory', 'openAttempts', 'audit', 'examTitles', 'counts',
    'forumQuestions', 'forumReplies', 'proctoringLogs', 'keystrokes',
]);

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
    const entry = Object.freeze({ ...handler, collection, label, exportKey });
    handlers.set(collection, entry);
    return () => { if (handlers.get(collection) === entry) handlers.delete(collection); };
}

function studentDataHandlers() {
    return [...handlers.values()];
}

function withFunction(name) {
    return studentDataHandlers().filter(handler => typeof handler[name] === 'function');
}

function hasStudentDataHandlers(name) {
    return name ? withFunction(name).length > 0 : handlers.size > 0;
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

function anonymizeStudentData(memory, aluno, pseudonimo) {
    withFunction('anonymize').forEach(handler => handler.anonymize(memory, aluno, pseudonimo));
}

function purgeStudentData(memory, aluno) {
    withFunction('purge').forEach(handler => handler.purge(memory, aluno));
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

function studentDataLabels() {
    const out = {};
    studentDataHandlers().forEach(handler => { out[handler.collection] = handler.label; });
    return out;
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
//   do 'sai' entram como versões anteriores do registro do 'fica', todas na ordem de
//   orderBy (requestAt) e renumeradas em number (n) a partir de 1; o resto do registro
//   do 'fica' (a nota, a devolução) vale, e ele ganha mergedFrom; o do 'sai' sai da
//   lista (o que só ele tinha fica no mergedFrom, por summary);
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
    let moved = 0;
    let joined = 0;
    let archived = 0;
    list.forEach(record => {
        if (!record || isFica(record) || !isSai(record)) return;
        const key = keyFor(record);
        const pair = key === null ? null : ficaByKey.get(key);
        if (!pair) {
            reassign(record);
            if (key !== null) ficaByKey.set(key, record);
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
            const combined = [
                ...(Array.isArray(record[field]) ? record[field] : []),
                ...(Array.isArray(pair[field]) ? pair[field] : []),
            ].map((item, index) => ({ item, index }))
                .sort((a, b) => order(a.item) - order(b.item) || a.index - b.index)
                .map(({ item }) => item);
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
    studentDataLabels,
    relinkRecordsByEmail,
    mergeOwnedRecords,
};
