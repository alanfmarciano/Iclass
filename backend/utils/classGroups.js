// ---------------------------------------------------------------------------
// Grupos de alunos da turma (fase 3, P5, CRIT-11; contrato "classGroups" do plano e C2
// do P5): grupos só são lidos e gravados por aqui. Nenhum outro arquivo do servidor lê
// memory.classGroups (o teste de student-preview.test.js recusa).
//
// Formato da linha (modelo_de_dados.classGroups do P5):
// { id: 'grp_<ms>_<6 hex>', schemaVersion: 1, courseId, studentClass, nome (1-60),
//   conjunto (1-40, padrão 'Grupos'), tipo: 'equipe' | 'subturma' (só rótulo),
//   membros: [{ email (minúsculo), studentId: string | null, adicionadoEm (ms),
//   adicionadoPor }], sorteio?: { semente, criterio: 'quantidade' | 'tamanho', valor },
//   criadoEm, criadoPor, atualizadoEm, atualizadoPor, arquivadoEm: ms | null, arquivadoPor }.
// Leitura tolerante: campo ausente vale o padrão, sem reescrever a linha (a coleção nasce
// vazia pelo registro, missing 'keep'; nenhuma migração).
//
// Regras (D16 e D17 do P5):
// - nome único por turma e conjunto entre os grupos ativos, sem diferença de acento e
//   maiúscula (textSearch.normalizeSearch); o conjunto também se compara assim e guarda a
//   grafia do primeiro grupo dele ('laboratorio' entra em 'Laboratório');
// - dentro do mesmo conjunto de uma turma o aluno está em no máximo um grupo ativo
//   (subturma A e B, equipes 1 a 5); em conjuntos diferentes pode estar em vários;
// - até 60 grupos ativos por turma e 200 membros por grupo; quem entra precisa estar
//   matriculado na turma, com o cadastro ativo (desligado e anonimizado não entram);
// - grupo não se exclui: arquiva e reativa. Quem sai da turma continua na lista do grupo,
//   mas não conta (naTurma false, 'Saiu da turma'); os leitores usam groupMemberEmails,
//   que cruza com a matrícula atual;
// - sorteio em dois passos: drawProposal devolve a proposta, a semente e a assinatura;
//   confirmDraw refaz o sorteio com a mesma semente e só cria se a proposta for a mesma
//   (409 roster_changed quando a turma mudou no meio). A semente vem de crypto.randomBytes
//   e o embaralhamento é determinístico a partir dela (sha256 em contador), para "mesma
//   semente, mesma proposta".
//
// Leitores do contrato C2 (outros módulos usam só estes): activeGroupsForClass,
// groupsOfStudent, groupMemberEmails e findGroup.
// Usos do grupo (C19 / P5-S5, D18): aviso e evento com destino 'grupo'
// (groupTargetReaches), liberação por grupo em classes[].groupReleasedItems
// (groupReleasedItemsFor, groupReleasesView, setGroupRelease), chamada e "Para quem" por
// grupo (groupMemberEmails, groupOptionsForClass) e o rótulo (groupLabel). Grupo
// arquivado não vale em nenhum deles; a prévia do professor com grupo conta como membro.
// Ciclo de vida do aluno: handler 'classGroups' em utils/studentDataHandlers.js (troca de
// e-mail, anonimizar, apagar de vez, mesclar, religar, contar e Meus dados).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { normalizeSearch, compareText, compareOrdinal } = require('./textSearch.js');
const {
    normalizeEmail, displayName, studentInClass, isClosedStudentStatus, isAnonymizedStudent,
} = require('./students.js');
const { publicStudentEmail } = require('./studentIdentity.js');
const { registerStudentDataHandler, relinkRecordsByEmail } = require('./studentDataHandlers.js');

const SCHEMA_VERSION = 1;
const GROUP_TYPES = Object.freeze(['equipe', 'subturma']);
const DRAW_CRITERIA = Object.freeze(['quantidade', 'tamanho']);
const DEFAULT_SET = 'Grupos';
const DEFAULT_TYPE = 'equipe';
const DEFAULT_DRAW_BASE = 'Grupo';
const LIMITS = Object.freeze({
    nameMax: 60,
    setMax: 40,
    groupsPerClass: 60,
    membersPerGroup: 200,
    reasonMax: 200,
    drawMin: 2,
    drawMax: 20,
    drawBaseMax: 40,
    seedMax: 64,
});
const TYPE_LABELS = Object.freeze({ equipe: 'Equipe', subturma: 'Subturma' });
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const SEED_PATTERN = /^[0-9a-f]{8,64}$/;

function list(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function groupList(memory) {
    return Array.isArray(memory && memory.classGroups) ? memory.classGroups.filter(group => group && typeof group === 'object') : [];
}

function ensureList(memory) {
    if (!Array.isArray(memory.classGroups)) memory.classGroups = [];
    return memory.classGroups;
}

function cleanText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function msOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Grupo arquivado: arquivadoEm preenchido (qualquer valor que não seja null, 0 ou vazio).
// Falha fechada: um valor estranho conta como arquivado.
function isGroupArchived(group) {
    if (!group || typeof group !== 'object') return true;
    const value = group.arquivadoEm;
    return !(value === undefined || value === null || value === 0 || value === '');
}

// Turma como objeto de classes ({ courseId, name }) ou como { courseId, studentClass }.
function classKey(cls) {
    if (!cls || typeof cls !== 'object') return null;
    const courseId = String(cls.courseId || '');
    const studentClass = String(cls.name !== undefined ? cls.name : (cls.studentClass || ''));
    return courseId && studentClass ? { courseId, studentClass } : null;
}

function sameClass(group, key) {
    return !!key && String(group.courseId || '') === key.courseId && String(group.studentClass || '') === key.studentClass;
}

// A turma do grupo em memory.classes (ou null, se ela não existe mais).
function classOfGroup(memory, group) {
    if (!group) return null;
    return list(memory && memory.classes).find(cls => cls
        && String(cls.courseId || '') === String(group.courseId || '')
        && String(cls.name || '') === String(group.studentClass || '')) || null;
}

// Linha lida com os padrões (sem mexer na gravada).
function readGroup(group) {
    const tipo = GROUP_TYPES.includes(group.tipo) ? group.tipo : DEFAULT_TYPE;
    return {
        id: String(group.id || ''),
        courseId: String(group.courseId || ''),
        studentClass: String(group.studentClass || ''),
        nome: cleanText(group.nome) || 'Grupo sem nome',
        conjunto: cleanText(group.conjunto) || DEFAULT_SET,
        tipo,
        membros: list(group.membros).filter(isObject).map(member => ({
            email: normalizeEmail(member.email),
            studentId: typeof member.studentId === 'string' && member.studentId ? member.studentId : null,
            adicionadoEm: msOrNull(member.adicionadoEm),
            adicionadoPor: typeof member.adicionadoPor === 'string' ? member.adicionadoPor : null,
        })).filter(member => member.email),
        sorteio: isObject(group.sorteio) ? group.sorteio : null,
        criadoEm: msOrNull(group.criadoEm),
        criadoPor: typeof group.criadoPor === 'string' ? group.criadoPor : null,
        atualizadoEm: msOrNull(group.atualizadoEm) ?? msOrNull(group.criadoEm) ?? 0,
        atualizadoPor: typeof group.atualizadoPor === 'string' ? group.atualizadoPor : null,
        arquivadoEm: isGroupArchived(group) ? (msOrNull(group.arquivadoEm) ?? group.arquivadoEm) : null,
        arquivadoPor: typeof group.arquivadoPor === 'string' ? group.arquivadoPor : null,
    };
}

function memberEmailsOf(group) {
    return list(group && group.membros).filter(isObject).map(member => normalizeEmail(member.email)).filter(Boolean);
}

// ------------------------------------------------------------ leitores (contrato C2)
// O grupo deste id (ativo ou arquivado), ou null.
function findGroup(memory, id) {
    if (id === undefined || id === null || id === '') return null;
    const wanted = String(id);
    return groupList(memory).find(group => String(group.id) === wanted) || null;
}

// Grupos ativos (não arquivados) da turma, na ordem gravada.
function activeGroupsForClass(memory, cls) {
    const key = classKey(cls);
    if (!key) return [];
    return groupList(memory).filter(group => !isGroupArchived(group) && sameClass(group, key));
}

// Todos os grupos da turma (arquivados só com includeArchived), na ordem gravada.
function groupsForClass(memory, cls, { includeArchived = false } = {}) {
    const key = classKey(cls);
    if (!key) return [];
    return groupList(memory).filter(group => sameClass(group, key) && (includeArchived || !isGroupArchived(group)));
}

// Grupos ativos da turma em que o aluno (e-mail) está.
function groupsOfStudent(memory, cls, email) {
    const wanted = normalizeEmail(email);
    if (!wanted) return [];
    return activeGroupsForClass(memory, cls).filter(group => memberEmailsOf(group).includes(wanted));
}

// O aluno conta na turma: matriculado nela e com o cadastro ativo (desligado, concluído,
// transferido, evadido e anonimizado não contam; bloqueado conta).
function studentCountsInClass(student, key) {
    return !!student && !!key && !isAnonymizedStudent(student) && !isClosedStudentStatus(student.status)
        && studentInClass(student, key.studentClass, key.courseId);
}

function studentsByEmail(memory) {
    const map = new Map();
    list(memory && memory.students).forEach(student => {
        const email = normalizeEmail(student && student.email);
        if (email && !map.has(email)) map.set(email, student);
    });
    return map;
}

// E-mails dos membros do grupo que ainda estão na turma (matriculados e ativos), na
// ordem do grupo. Grupo arquivado ou que não existe: lista vazia (falha fechada). cls
// opcional: a turma do próprio grupo.
// includeClosed (chamada por grupo, P5-S5): conta também o membro ainda matriculado na
// turma com o cadastro encerrado (desligado, concluído...), que a chamada mostra nas datas
// em que ele tem registro; quem saiu da turma continua fora.
function groupMemberEmails(memory, groupId, { cls, includeClosed = false } = {}) {
    const group = typeof groupId === 'object' && groupId ? groupId : findGroup(memory, groupId);
    if (!group || isGroupArchived(group)) return [];
    const key = classKey(cls) || classKey({ courseId: group.courseId, studentClass: group.studentClass });
    if (!key || !sameClass(group, key)) return [];
    const students = studentsByEmail(memory);
    const counts = includeClosed
        ? student => !!student && studentInClass(student, key.studentClass, key.courseId)
        : student => studentCountsInClass(student, key);
    return memberEmailsOf(group).filter(email => counts(students.get(email)));
}

// Alunos que podem entrar num grupo da turma: matriculados e ativos, por nome.
function classRoster(memory, cls) {
    const key = classKey(cls);
    if (!key) return [];
    return list(memory && memory.students)
        .filter(student => student && normalizeEmail(student.email) && studentCountsInClass(student, key))
        .sort((a, b) => compareText(displayName(a) || a.email, displayName(b) || b.email) || compareOrdinal(normalizeEmail(a.email), normalizeEmail(b.email)));
}

// ------------------------------------------------------------ apresentação
function studentLabel(student, email) {
    return (student && displayName(student)) || publicStudentEmail(email) || email;
}

function presentMember(member, students, key) {
    const student = students.get(member.email) || null;
    return {
        email: member.email,
        studentId: member.studentId || (student && typeof student.id === 'string' ? student.id : null),
        nome: studentLabel(student, member.email),
        matricula: student && student.matricula ? String(student.matricula) : '',
        naTurma: studentCountsInClass(student, key),
        adicionadoEm: member.adicionadoEm,
    };
}

// O grupo como o painel recebe (membros por nome, com quem saiu da turma marcado).
function presentGroup(memory, group, students = studentsByEmail(memory)) {
    const read = readGroup(group);
    const key = { courseId: read.courseId, studentClass: read.studentClass };
    const membros = read.membros.map(member => presentMember(member, students, key))
        .sort((a, b) => compareText(a.nome, b.nome) || compareOrdinal(a.email, b.email));
    return {
        id: read.id,
        courseId: read.courseId,
        studentClass: read.studentClass,
        nome: read.nome,
        conjunto: read.conjunto,
        tipo: read.tipo,
        tipoTexto: TYPE_LABELS[read.tipo],
        membros,
        membrosNaTurma: membros.filter(member => member.naTurma).length,
        sorteio: read.sorteio,
        criadoEm: read.criadoEm,
        atualizadoEm: read.atualizadoEm,
        arquivadoEm: read.arquivadoEm,
        arquivado: read.arquivadoEm !== null,
    };
}

function compareSets(a, b) {
    return compareText(a, b) || compareOrdinal(a, b);
}

// Lista do painel: { grupos, conjuntos, semGrupo, alunos }. conjuntos: os dos grupos
// ativos (e dos arquivados, com includeArchived), em ordem alfabética; semGrupo: por
// conjunto, os e-mails dos alunos da turma sem grupo ativo nele; alunos: a turma.
function classGroupsView(memory, cls, { includeArchived = false } = {}) {
    const students = studentsByEmail(memory);
    const roster = classRoster(memory, cls);
    const rows = groupsForClass(memory, cls, { includeArchived });
    const grupos = rows.map(group => presentGroup(memory, group, students))
        .sort((a, b) => compareSets(a.conjunto, b.conjunto) || Number(a.arquivado) - Number(b.arquivado) || compareText(a.nome, b.nome));
    const conjuntos = [];
    const seen = new Set();
    grupos.forEach(group => {
        const norm = normalizeSearch(group.conjunto);
        if (!seen.has(norm)) { seen.add(norm); conjuntos.push(group.conjunto); }
    });
    conjuntos.sort(compareSets);
    const semGrupo = {};
    conjuntos.forEach(conjunto => {
        const busy = new Set();
        activeGroupsForClass(memory, cls)
            .filter(group => normalizeSearch(readGroup(group).conjunto) === normalizeSearch(conjunto))
            .forEach(group => memberEmailsOf(group).forEach(email => busy.add(email)));
        semGrupo[conjunto] = roster.map(student => normalizeEmail(student.email)).filter(email => !busy.has(email));
    });
    const alunos = roster.map(student => ({
        email: normalizeEmail(student.email),
        studentId: typeof student.id === 'string' ? student.id : null,
        nome: studentLabel(student, student.email),
        matricula: student.matricula ? String(student.matricula) : '',
    }));
    return { grupos, conjuntos, semGrupo, alunos };
}

// Portal do aluno (GET /api/student/groups): os grupos ativos dele na turma, com o nome
// dos colegas que ainda estão na turma (P-C3: só o nome, sem e-mail nem telefone).
function studentGroupsView(memory, cls, email, { groups } = {}) {
    const wanted = normalizeEmail(email);
    const key = classKey(cls);
    const students = studentsByEmail(memory);
    const rows = Array.isArray(groups) ? groups : groupsOfStudent(memory, cls, wanted);
    return rows.map(group => {
        const read = readGroup(group);
        const colegas = memberEmailsOf(group)
            .filter(memberEmail => memberEmail !== wanted)
            .map(memberEmail => students.get(memberEmail))
            .filter(student => studentCountsInClass(student, key))
            .map(student => studentLabel(student, student.email))
            .sort(compareText);
        return { id: read.id, nome: read.nome, conjunto: read.conjunto, tipo: read.tipo, tipoTexto: TYPE_LABELS[read.tipo], colegas };
    }).sort((a, b) => compareSets(a.conjunto, b.conjunto) || compareText(a.nome, b.nome));
}

// ------------------------------------------------------------ usos do grupo (P5-S5)
// Onde o grupo vale nesta fase (D18 do P5): aviso e evento do calendário com destino
// 'grupo' (targetValue = id do grupo), liberação de apostila e de gabarito por grupo
// (classes[].groupReleasedItems = { [groupId]: { [itemKey]: boolean } }), chamada filtrada
// por grupo e o "Para quem: um grupo" da prova (participants = groupMemberEmails na
// preparação, application.groupId só como rótulo). Grupo arquivado deixa de valer em
// todos: os leitores daqui só olham os grupos ativos da turma.
const PREVIEW_EMAIL_SUFFIX = '@previa.invalid';
const INHERITED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Chave que pode ser liberada por grupo: apostila e gabarito (a rota confere pela
// estrutura do curso). A prova online nunca (ela usa o "Para quem"): a chave
// 'Avaliacao_' fica de fora também na leitura, e getReleasedItemsForClass tira as provas
// da estrutura. Chave herdada ('__proto__') nunca entra.
function isGroupReleaseKey(key) {
    const text = typeof key === 'string' ? key : '';
    return !!text && !INHERITED_KEYS.has(text) && !text.startsWith('Avaliacao_');
}

// O grupo ativo da turma com este id, ou null (outra turma, arquivado ou inexistente).
function activeGroupInClass(memory, cls, groupId) {
    if (groupId === undefined || groupId === null || groupId === '') return null;
    const wanted = String(groupId);
    return activeGroupsForClass(memory, cls).find(group => String(group.id) === wanted) || null;
}

// Aluno virtual da pré-visualização (P5-S6a, e-mail '...@previa.invalid'): o grupo
// escolhido ao abrir a prévia, se ainda é um grupo ativo da mesma turma. A prévia fica em
// memory.previewSessions (utils/authSessions.js), lida aqui sem mudar nada.
function previewGroupIds(memory, key, email) {
    if (!email.endsWith(PREVIEW_EMAIL_SUFFIX)) return [];
    const { previewSessionOfStudentEmail } = require('./authSessions.js');
    const session = previewSessionOfStudentEmail(memory, email);
    if (!session || !session.groupId) return [];
    if (String(session.courseId || '') !== key.courseId || String(session.studentClass || '') !== key.studentClass) return [];
    const group = activeGroupInClass(memory, key, session.groupId);
    return group ? [String(group.id)] : [];
}

// Ids dos grupos ativos da turma que valem para o aluno: aqueles em que ele está e conta
// na turma (matriculado e ativo), ou o grupo da pré-visualização. Conjunto vazio sem grupo.
function studentGroupIdsInClass(memory, cls, email) {
    const key = classKey(cls);
    const wanted = normalizeEmail(email);
    const ids = new Set();
    if (!key || !wanted) return ids;
    const groups = activeGroupsForClass(memory, key);
    if (groups.length) {
        const student = studentsByEmail(memory).get(wanted);
        if (studentCountsInClass(student, key)) {
            groups.forEach(group => { if (memberEmailsOf(group).includes(wanted)) ids.add(String(group.id)); });
        }
    }
    previewGroupIds(memory, key, wanted).forEach(id => ids.add(id));
    return ids;
}

// O aviso ou evento com destino 'grupo' (targetValue = id do grupo, courseId e
// studentClass da turma) chega a este aluno no contexto curso + turma? Só para os membros
// atuais de um grupo ativo; grupo arquivado não chega a ninguém.
function groupTargetReaches(memory, item, { courseId, studentClass, email } = {}) {
    if (!item || item.target !== 'grupo') return false;
    const course = String(courseId || '');
    const className = String(studentClass || '');
    if (!course || !className) return false;
    if (String(item.courseId || '') !== course || String(item.studentClass || '') !== className) return false;
    return studentGroupIdsInClass(memory, { courseId: course, studentClass: className }, email).has(String(item.targetValue || ''));
}

// Liberação pelos grupos do aluno: { [itemKey]: true }. Liberado em qualquer grupo dele
// vence; o grupo só acrescenta liberação, nunca bloqueia o que a turma liberou (D18). Um
// valor diferente de true no mapa (não deveria existir: bloquear tira a chave) é ignorado.
// Só apostila e gabarito (isGroupReleaseKey). Quem chama aplica a exceção individual por cima.
function groupReleasedItemsFor(memory, cls, email) {
    const map = cls && isObject(cls.groupReleasedItems) ? cls.groupReleasedItems : null;
    if (!map) return {};
    const ids = studentGroupIdsInClass(memory, cls, email);
    const released = {};
    ids.forEach(id => {
        if (!Object.prototype.hasOwnProperty.call(map, id) || !isObject(map[id])) return;
        Object.keys(map[id]).forEach(itemKey => {
            if (isGroupReleaseKey(itemKey) && map[id][itemKey] === true) released[itemKey] = true;
        });
    });
    return released;
}

// Tira o item da liberação de todos os grupos da turma (nova aplicação da prova volta a
// bloquear o gabarito). Apaga a chave, nunca grava false; o grupo que fica vazio sai do
// mapa. Devolve true quando algum grupo tinha o item liberado.
function clearGroupReleasesOf(cls, itemKey) {
    const map = cls && isObject(cls.groupReleasedItems) ? cls.groupReleasedItems : null;
    if (!map) return false;
    let changed = false;
    Object.keys(map).forEach(id => {
        const items = map[id];
        if (!isObject(items) || !Object.prototype.hasOwnProperty.call(items, itemKey)) return;
        if (items[itemKey] === true) changed = true;
        delete items[itemKey];
        if (!Object.keys(items).length) delete map[id];
    });
    return changed;
}

// Para o painel (Materiais): por item, os grupos ativos da turma com ele liberado, em
// ordem de conjunto e nome: { [itemKey]: [{ id, nome, conjunto }] }.
function groupReleasesView(memory, cls) {
    const map = cls && isObject(cls.groupReleasedItems) ? cls.groupReleasedItems : null;
    const out = {};
    if (!map) return out;
    activeGroupsForClass(memory, cls).map(readGroup)
        .sort((a, b) => compareSets(a.conjunto, b.conjunto) || compareText(a.nome, b.nome))
        .forEach(group => {
            const items = Object.prototype.hasOwnProperty.call(map, group.id) && isObject(map[group.id]) ? map[group.id] : {};
            Object.keys(items).forEach(itemKey => {
                if (!isGroupReleaseKey(itemKey) || items[itemKey] !== true) return;
                if (!out[itemKey]) out[itemKey] = [];
                out[itemKey].push({ id: group.id, nome: group.nome, conjunto: group.conjunto });
            });
        });
    return out;
}

// Liga ou desliga o item para o grupo (POST /api/admin/release-item com groupId). Liberar
// grava true; desligar tira a liberação do grupo (o item volta a seguir a turma). Devolve
// true quando mudou algo.
function setGroupRelease(cls, groupId, itemKey, released) {
    const id = String(groupId);
    if (!isObject(cls.groupReleasedItems)) cls.groupReleasedItems = {};
    const map = cls.groupReleasedItems;
    const current = Object.prototype.hasOwnProperty.call(map, id) && isObject(map[id]) ? map[id] : null;
    if (released) {
        if (current && current[itemKey] === true) return false;
        if (!current) map[id] = {};
        map[id][itemKey] = true;
        return true;
    }
    if (!current || !Object.prototype.hasOwnProperty.call(current, itemKey)) return false;
    delete current[itemKey];
    if (!Object.keys(current).length) delete map[id];
    return true;
}

// Opções dos seletores das telas (Avisos, Materiais, Chamada, Para quem): os grupos ativos
// da turma, por conjunto e nome, com os membros que ainda estão na turma.
function groupOptionsForClass(memory, cls) {
    const key = classKey(cls);
    if (!key) return [];
    return activeGroupsForClass(memory, key).map(group => {
        const read = readGroup(group);
        const membros = groupMemberEmails(memory, group, { cls: key });
        return { id: read.id, nome: read.nome, conjunto: read.conjunto, tipo: read.tipo, membros, quantidade: membros.length };
    }).sort((a, b) => compareSets(a.conjunto, b.conjunto) || compareText(a.nome, b.nome));
}

// Rótulo de um grupo já citado (aviso, aplicação de prova): { id, nome, conjunto,
// arquivado } ou null quando ele não existe mais.
function groupLabel(memory, groupId) {
    const group = findGroup(memory, groupId);
    if (!group) return null;
    const read = readGroup(group);
    return { id: read.id, nome: read.nome, conjunto: read.conjunto, arquivado: read.arquivadoEm !== null };
}

// ------------------------------------------------------------ regras
function newGroupId(now = Date.now(), taken = null) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const id = `grp_${now}_${crypto.randomBytes(3).toString('hex')}`;
        if (!taken || !taken.has(id)) return id;
    }
    return `grp_${now}_${crypto.randomBytes(6).toString('hex')}`;
}

function failure(status, error, extra = {}) {
    return { ok: false, status, error, ...extra };
}

// Conjunto como gravado: a grafia de um grupo da turma que já usa esse conjunto (sem
// diferença de acento e maiúscula) ou o texto digitado; vazio vale 'Grupos'.
function canonicalSet(memory, key, value) {
    const typed = cleanText(value) || DEFAULT_SET;
    const norm = normalizeSearch(typed);
    const found = groupsForClass(memory, key, { includeArchived: true })
        .map(group => readGroup(group).conjunto)
        .find(conjunto => normalizeSearch(conjunto) === norm);
    return found || typed;
}

function checkName(nome) {
    const value = cleanText(nome);
    if (!value) return failure(400, 'Informe o nome do grupo.', { field: 'nome' });
    if (value.length > LIMITS.nameMax) return failure(400, `O nome do grupo aceita no máximo ${LIMITS.nameMax} caracteres.`, { field: 'nome' });
    return { ok: true, value };
}

function checkSet(conjunto) {
    const value = cleanText(conjunto) || DEFAULT_SET;
    if (value.length > LIMITS.setMax) return failure(400, `O nome do conjunto aceita no máximo ${LIMITS.setMax} caracteres.`, { field: 'conjunto' });
    return { ok: true, value };
}

// Outro grupo ativo da turma, no mesmo conjunto, com o mesmo nome (sem acento e caixa).
function nameTaken(memory, key, conjunto, nome, exceptId = null) {
    const setNorm = normalizeSearch(conjunto);
    const nameNorm = normalizeSearch(nome);
    return activeGroupsForClass(memory, key).find(group => String(group.id) !== String(exceptId || '')
        && normalizeSearch(readGroup(group).conjunto) === setNorm
        && normalizeSearch(readGroup(group).nome) === nameNorm) || null;
}

// O grupo ativo do conjunto em que o aluno já está (menos o exceptId), ou null.
function groupOfInSet(memory, key, conjunto, email, exceptId = null) {
    const setNorm = normalizeSearch(conjunto);
    return activeGroupsForClass(memory, key).find(group => String(group.id) !== String(exceptId || '')
        && normalizeSearch(readGroup(group).conjunto) === setNorm
        && memberEmailsOf(group).includes(email)) || null;
}

function busyMessage(student, email, group) {
    return `${studentLabel(student, email)} já está no grupo ${readGroup(group).nome} deste conjunto.`;
}

// Lista de e-mails para entrar: minúsculos, sem repetir, cada um aluno da turma (ativo).
// { ok, emails, students } ou falha 400.
function checkNewMembers(memory, key, emails, field) {
    const students = studentsByEmail(memory);
    const out = [];
    for (const raw of list(emails)) {
        const email = normalizeEmail(raw);
        if (!email || out.includes(email)) continue;
        const student = students.get(email);
        if (!studentCountsInClass(student, key)) {
            return failure(400, student
                ? `${studentLabel(student, email)} não está matriculado nesta turma (ou o cadastro não está ativo).`
                : 'Aluno não encontrado nesta turma.', { field, code: 'student_not_in_class' });
        }
        out.push(email);
    }
    return { ok: true, emails: out, students };
}

function memberRecord(email, student, actor, now) {
    return {
        email,
        studentId: student && typeof student.id === 'string' && student.id ? student.id : null,
        adicionadoEm: now,
        adicionadoPor: actor,
    };
}

function actorEmail(actor) {
    if (typeof actor === 'string') return normalizeEmail(actor) || null;
    return normalizeEmail(actor && actor.email) || null;
}

// Criar um grupo. input: { nome, conjunto, tipo, membros }. Devolve { ok, group } ou a
// falha { ok: false, status, error, field?, code? } sem mudar nada.
function createGroup(memory, cls, input = {}, { actor, now = Date.now() } = {}) {
    const key = classKey(cls);
    if (!key) return failure(404, 'Turma não encontrada.', { field: 'studentClass' });
    const name = checkName(input.nome);
    if (!name.ok) return name;
    const set = checkSet(input.conjunto);
    if (!set.ok) return set;
    const tipo = input.tipo === undefined || input.tipo === null || input.tipo === '' ? DEFAULT_TYPE : input.tipo;
    if (!GROUP_TYPES.includes(tipo)) return failure(400, 'Escolha o tipo: equipe ou subturma.', { field: 'tipo' });
    const conjunto = canonicalSet(memory, key, set.value);
    if (activeGroupsForClass(memory, key).length >= LIMITS.groupsPerClass) {
        return failure(409, `Esta turma já tem ${LIMITS.groupsPerClass} grupos ativos. Arquive um grupo antes de criar outro.`, { code: 'group_limit' });
    }
    if (nameTaken(memory, key, conjunto, name.value)) {
        return failure(409, `Já existe um grupo com o nome ${name.value} no conjunto ${conjunto}.`, { field: 'nome', code: 'group_name_taken' });
    }
    const members = checkNewMembers(memory, key, input.membros, 'membros');
    if (!members.ok) return members;
    if (members.emails.length > LIMITS.membersPerGroup) {
        return failure(400, `Um grupo aceita no máximo ${LIMITS.membersPerGroup} alunos.`, { field: 'membros' });
    }
    for (const email of members.emails) {
        const busy = groupOfInSet(memory, key, conjunto, email);
        if (busy) return failure(409, busyMessage(members.students.get(email), email, busy), { field: 'membros', code: 'student_in_other_group', groupId: String(busy.id) });
    }
    const by = actorEmail(actor);
    const group = {
        id: newGroupId(now, new Set(groupList(memory).map(item => String(item.id)))),
        schemaVersion: SCHEMA_VERSION,
        courseId: key.courseId,
        studentClass: key.studentClass,
        nome: name.value,
        conjunto,
        tipo,
        membros: members.emails.map(email => memberRecord(email, members.students.get(email), by, now)),
        criadoEm: now,
        criadoPor: by,
        atualizadoEm: now,
        atualizadoPor: by,
        arquivadoEm: null,
        arquivadoPor: null,
    };
    ensureList(memory).push(group);
    return { ok: true, group };
}

// Alterar um grupo ativo. input: { nome?, conjunto?, tipo?, adicionar?, remover?,
// atualizadoEm, mover? }. atualizadoEm precisa ser o da última leitura (409 group_changed:
// outra pessoa mudou o grupo). mover: true tira do outro grupo do conjunto quem entra
// (o "Mover para" da tela); sem ele, quem já está em outro grupo do conjunto dá 409.
// Devolve { ok, group, changed, adicionados, removidos, antes, depois, movidos: [{ group,
// emails }] }.
function updateGroup(memory, id, input = {}, { actor, now = Date.now() } = {}) {
    const group = findGroup(memory, id);
    if (!group) return failure(404, 'Grupo não encontrado.', { code: 'group_not_found' });
    if (isGroupArchived(group)) return failure(409, 'Este grupo está arquivado. Reative o grupo para alterar.', { code: 'group_archived' });
    const current = readGroup(group);
    if (Number(input.atualizadoEm) !== current.atualizadoEm) {
        return failure(409, 'Este grupo foi alterado por outra pessoa enquanto você editava. Abra o grupo de novo para ver como ele está agora.', { code: 'group_changed' });
    }
    const key = { courseId: current.courseId, studentClass: current.studentClass };
    let nome = current.nome;
    if (input.nome !== undefined) {
        const checked = checkName(input.nome);
        if (!checked.ok) return checked;
        nome = checked.value;
    }
    let conjunto = current.conjunto;
    if (input.conjunto !== undefined) {
        const checked = checkSet(input.conjunto);
        if (!checked.ok) return checked;
        conjunto = normalizeSearch(checked.value) === normalizeSearch(current.conjunto) ? current.conjunto : canonicalSet(memory, key, checked.value);
    }
    let tipo = current.tipo;
    if (input.tipo !== undefined && input.tipo !== null && input.tipo !== '') {
        if (!GROUP_TYPES.includes(input.tipo)) return failure(400, 'Escolha o tipo: equipe ou subturma.', { field: 'tipo' });
        tipo = input.tipo;
    }
    if ((nome !== current.nome || normalizeSearch(conjunto) !== normalizeSearch(current.conjunto)) && nameTaken(memory, key, conjunto, nome, group.id)) {
        return failure(409, `Já existe um grupo com o nome ${nome} no conjunto ${conjunto}.`, { field: 'nome', code: 'group_name_taken' });
    }
    const removeSet = new Set(list(input.remover).map(normalizeEmail).filter(Boolean));
    const currentEmails = current.membros.map(member => member.email);
    const added = checkNewMembers(memory, key, list(input.adicionar).filter(email => !currentEmails.includes(normalizeEmail(email)) && !removeSet.has(normalizeEmail(email))), 'adicionar');
    if (!added.ok) return added;
    const removed = currentEmails.filter(email => removeSet.has(email));
    const nextEmails = currentEmails.filter(email => !removeSet.has(email)).concat(added.emails);
    if (nextEmails.length > LIMITS.membersPerGroup) return failure(400, `Um grupo aceita no máximo ${LIMITS.membersPerGroup} alunos.`, { field: 'adicionar' });
    // Exclusividade no conjunto (o novo, se mudou): quem entra e, ao trocar de conjunto,
    // quem fica.
    const setChanged = normalizeSearch(conjunto) !== normalizeSearch(current.conjunto);
    const toCheck = setChanged ? nextEmails : added.emails;
    const moves = new Map();
    for (const email of toCheck) {
        const busy = groupOfInSet(memory, key, conjunto, email, group.id);
        if (!busy) continue;
        if (input.mover === true && added.emails.includes(email) && !setChanged) {
            if (!moves.has(busy)) moves.set(busy, []);
            moves.get(busy).push(email);
            continue;
        }
        return failure(409, busyMessage(added.students.get(email) || studentsByEmail(memory).get(email), email, busy), { field: 'adicionar', code: 'student_in_other_group', groupId: String(busy.id) });
    }
    const changed = nome !== current.nome || conjunto !== current.conjunto || tipo !== current.tipo || removed.length > 0 || added.emails.length > 0;
    const antes = { nome: current.nome, conjunto: current.conjunto, tipo: current.tipo };
    if (!changed) return { ok: true, group, changed: false, adicionados: [], removidos: [], antes, depois: antes, movidos: [] };
    const by = actorEmail(actor);
    group.nome = nome;
    group.conjunto = conjunto;
    group.tipo = tipo;
    group.membros = list(group.membros).filter(member => !(isObject(member) && removeSet.has(normalizeEmail(member.email))))
        .concat(added.emails.map(email => memberRecord(email, added.students.get(email), by, now)));
    group.atualizadoEm = now;
    group.atualizadoPor = by;
    const movidos = [];
    moves.forEach((emails, source) => {
        source.membros = list(source.membros).filter(member => !(isObject(member) && emails.includes(normalizeEmail(member.email))));
        source.atualizadoEm = now;
        source.atualizadoPor = by;
        movidos.push({ group: source, emails });
    });
    return { ok: true, group, changed: true, adicionados: added.emails, removidos: removed, antes, depois: { nome, conjunto, tipo }, movidos };
}

function cleanReason(value) {
    return typeof value === 'string' ? value.trim().slice(0, LIMITS.reasonMax) : '';
}

// Arquivar: o grupo some das telas e dos seletores; avisos e liberações dele deixam de
// valer. Nada sai da linha. Já arquivado: { ok, changed: false }.
function archiveGroup(memory, id, { actor, now = Date.now() } = {}) {
    const group = findGroup(memory, id);
    if (!group) return failure(404, 'Grupo não encontrado.', { code: 'group_not_found' });
    if (isGroupArchived(group)) return { ok: true, group, changed: false };
    group.arquivadoEm = now;
    group.arquivadoPor = actorEmail(actor);
    group.atualizadoEm = now;
    group.atualizadoPor = actorEmail(actor);
    return { ok: true, group, changed: true };
}

// Reativar: volta a valer, se o nome não está em uso no conjunto e nenhum membro está em
// outro grupo ativo do conjunto (409, sem mudar nada).
function restoreGroup(memory, id, { actor, now = Date.now() } = {}) {
    const group = findGroup(memory, id);
    if (!group) return failure(404, 'Grupo não encontrado.', { code: 'group_not_found' });
    if (!isGroupArchived(group)) return { ok: true, group, changed: false };
    const read = readGroup(group);
    const key = { courseId: read.courseId, studentClass: read.studentClass };
    if (activeGroupsForClass(memory, key).length >= LIMITS.groupsPerClass) {
        return failure(409, `Esta turma já tem ${LIMITS.groupsPerClass} grupos ativos. Arquive um grupo antes de reativar este.`, { code: 'group_limit' });
    }
    if (nameTaken(memory, key, read.conjunto, read.nome, group.id)) {
        return failure(409, `Já existe um grupo ativo com o nome ${read.nome} no conjunto ${read.conjunto}. Mude o nome do outro grupo antes de reativar este.`, { code: 'group_name_taken' });
    }
    const students = studentsByEmail(memory);
    for (const email of read.membros.map(member => member.email)) {
        const busy = groupOfInSet(memory, key, read.conjunto, email, group.id);
        if (busy) {
            return failure(409, `${busyMessage(students.get(email), email, busy)} Tire o aluno de lá antes de reativar este grupo.`, { code: 'student_in_other_group', groupId: String(busy.id) });
        }
    }
    group.arquivadoEm = null;
    group.arquivadoPor = null;
    group.atualizadoEm = now;
    group.atualizadoPor = actorEmail(actor);
    return { ok: true, group, changed: true };
}

// ------------------------------------------------------------ sorteio
function newSeed() {
    return crypto.randomBytes(8).toString('hex');
}

// Gerador determinístico a partir da semente: inteiro uniforme em [0, max), por sha256 de
// 'semente:contador' (48 bits, com rejeição para não pender para os primeiros valores).
function seededRandom(seed) {
    let counter = 0;
    const LIMIT = 2 ** 48;
    return max => {
        if (max <= 1) return 0;
        const ceiling = Math.floor(LIMIT / max) * max;
        for (;;) {
            const digest = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest();
            const value = digest.readUIntBE(0, 6);
            if (value < ceiling) return value % max;
        }
    };
}

function shuffled(items, seed) {
    const out = items.slice();
    const random = seededRandom(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = random(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// Tamanhos: k grupos com n alunos, diferença de no máximo 1 (os primeiros levam um a mais).
function splitSizes(n, k) {
    const base = Math.floor(n / k);
    const extra = n % k;
    return Array.from({ length: k }, (_, index) => base + (index < extra ? 1 : 0));
}

// Nomes '<base> <n>' que ainda não existem no conjunto (entre os ativos).
function drawNames(memory, key, conjunto, base, count) {
    const names = [];
    for (let n = 1; names.length < count && n < 1000; n++) {
        const candidate = `${base} ${n}`;
        if (!nameTaken(memory, key, conjunto, candidate) && !names.some(name => normalizeSearch(name) === normalizeSearch(candidate))) names.push(candidate);
    }
    return names;
}

function drawSignature(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

// Proposta do sorteio. params: { conjunto, tipo, criterio, valor, nomeBase,
// somenteSemGrupo (padrão true), semente? }. Devolve { ok, proposta: [{ nome, membros:
// [{ email, nome }] }], semente, assinatura, conjunto, tipo, alunos } ou a falha.
function drawProposal(memory, cls, params = {}) {
    const key = classKey(cls);
    if (!key) return failure(404, 'Turma não encontrada.', { field: 'studentClass' });
    const set = checkSet(params.conjunto);
    if (!set.ok) return set;
    const conjunto = canonicalSet(memory, key, set.value);
    const tipo = params.tipo === undefined || params.tipo === null || params.tipo === '' ? DEFAULT_TYPE : params.tipo;
    if (!GROUP_TYPES.includes(tipo)) return failure(400, 'Escolha o tipo: equipe ou subturma.', { field: 'tipo' });
    if (!DRAW_CRITERIA.includes(params.criterio)) return failure(400, 'Escolha como sortear: pela quantidade de grupos ou pelo tamanho de cada grupo.', { field: 'criterio' });
    const valor = Number(params.valor);
    if (!Number.isInteger(valor) || valor < LIMITS.drawMin || valor > LIMITS.drawMax) {
        return failure(400, params.criterio === 'quantidade'
            ? `Informe de ${LIMITS.drawMin} a ${LIMITS.drawMax} grupos.`
            : `Informe de ${LIMITS.drawMin} a ${LIMITS.drawMax} alunos por grupo.`, { field: 'valor' });
    }
    const nomeBase = cleanText(params.nomeBase) || DEFAULT_DRAW_BASE;
    if (nomeBase.length > LIMITS.drawBaseMax) return failure(400, `O começo do nome aceita no máximo ${LIMITS.drawBaseMax} caracteres.`, { field: 'nomeBase' });
    const onlyWithout = params.somenteSemGrupo !== false;
    const setNorm = normalizeSearch(conjunto);
    const setGroups = activeGroupsForClass(memory, key).filter(group => normalizeSearch(readGroup(group).conjunto) === setNorm);
    if (!onlyWithout && setGroups.length) {
        return failure(409, `O conjunto ${conjunto} já tem grupos. Sorteie só quem está sem grupo ou escolha outro conjunto.`, { field: 'somenteSemGrupo', code: 'set_in_use' });
    }
    const busy = new Set();
    setGroups.forEach(group => memberEmailsOf(group).forEach(email => busy.add(email)));
    const pool = classRoster(memory, key)
        .filter(student => !busy.has(normalizeEmail(student.email)))
        .sort((a, b) => compareOrdinal(normalizeEmail(a.email), normalizeEmail(b.email)));
    const n = pool.length;
    if (n < 2) return failure(400, n === 0 ? 'Nenhum aluno sem grupo neste conjunto.' : 'Só há um aluno sem grupo neste conjunto; coloque esse aluno num grupo pela tela.', { code: 'nothing_to_draw' });
    const k = params.criterio === 'quantidade' ? valor : Math.ceil(n / valor);
    if (k > n) return failure(400, `Há ${n} aluno(s) para sortear; não dá para formar ${k} grupos.`, { field: 'valor', code: 'too_many_groups' });
    if (activeGroupsForClass(memory, key).length + k > LIMITS.groupsPerClass) {
        return failure(409, `O sorteio criaria ${k} grupos e a turma passaria de ${LIMITS.groupsPerClass} grupos ativos. Arquive grupos antes de sortear.`, { code: 'group_limit' });
    }
    const typedSeed = typeof params.semente === 'string' ? params.semente.trim().toLowerCase() : '';
    if (typedSeed && !SEED_PATTERN.test(typedSeed)) return failure(400, 'Semente do sorteio inválida. Sorteie de novo.', { field: 'semente' });
    const semente = typedSeed || newSeed();
    const order = shuffled(pool, semente);
    const sizes = splitSizes(n, k);
    const names = drawNames(memory, key, conjunto, nomeBase, k);
    let cursor = 0;
    const proposta = sizes.map((size, index) => {
        const membros = order.slice(cursor, cursor + size).map(student => ({
            email: normalizeEmail(student.email),
            nome: studentLabel(student, student.email),
        })).sort((a, b) => compareText(a.nome, b.nome) || compareOrdinal(a.email, b.email));
        cursor += size;
        return { nome: names[index] || `${nomeBase} ${index + 1}`, membros };
    });
    const assinatura = drawSignature({
        courseId: key.courseId,
        studentClass: key.studentClass,
        conjunto,
        tipo,
        criterio: params.criterio,
        valor,
        semente,
        proposta: proposta.map(group => ({ nome: group.nome, membros: group.membros.map(member => member.email) })),
    });
    return {
        ok: true,
        proposta,
        semente,
        assinatura,
        conjunto,
        tipo,
        criterio: params.criterio,
        valor,
        alunos: n,
    };
}

// Confirmar o sorteio: refaz com a semente e cria exatamente aquela proposta; se a turma
// mudou (outra assinatura), 409 roster_changed sem criar nada.
function confirmDraw(memory, cls, params = {}, { actor, now = Date.now() } = {}) {
    if (typeof params.semente !== 'string' || !params.semente.trim()) return failure(400, 'Sorteie antes de confirmar.', { field: 'semente' });
    if (typeof params.assinatura !== 'string' || !params.assinatura.trim()) return failure(400, 'Sorteie antes de confirmar.', { field: 'assinatura' });
    const draw = drawProposal(memory, cls, params);
    if (!draw.ok) return draw;
    if (draw.assinatura !== params.assinatura.trim()) {
        return failure(409, 'A turma ou os grupos mudaram depois do sorteio (alguém entrou, saiu ou ganhou grupo). Sorteie de novo.', { code: 'roster_changed' });
    }
    const key = classKey(cls);
    const by = actorEmail(actor);
    const students = studentsByEmail(memory);
    const taken = new Set(groupList(memory).map(item => String(item.id)));
    const created = draw.proposta.map(item => {
        const id = newGroupId(now, taken);
        taken.add(id);
        return {
            id,
            schemaVersion: SCHEMA_VERSION,
            courseId: key.courseId,
            studentClass: key.studentClass,
            nome: item.nome,
            conjunto: draw.conjunto,
            tipo: draw.tipo,
            membros: item.membros.map(member => memberRecord(member.email, students.get(member.email), by, now)),
            sorteio: { semente: draw.semente, criterio: draw.criterio, valor: draw.valor },
            criadoEm: now,
            criadoPor: by,
            atualizadoEm: now,
            atualizadoPor: by,
            arquivadoEm: null,
            arquivadoPor: null,
        };
    });
    ensureList(memory).push(...created);
    return { ok: true, groups: created, draw };
}

// Dados de demonstração (routes/testmode.js): troca os grupos de id com o prefixo pelos
// novos, sem tocar nos outros.
function replaceGroupsWithPrefix(memory, prefix, rows) {
    const keep = groupList(memory).filter(group => !String(group.id || '').startsWith(prefix));
    memory.classGroups = keep.concat(list(rows).filter(isObject));
    return memory.classGroups;
}

// ------------------------------------------------------------ ciclo de vida do aluno
// O membro é do aluno? (o e-mail no período em que foi dele, como as outras coleções).
function memberOf(aluno, group) {
    return member => isObject(member) && !!member.email && aluno.owns(member.email, group, 'renamed');
}

registerStudentDataHandler({
    collection: 'classGroups',
    label: 'Grupos de alunos',
    exportKey: 'grupos',
    rename(memory, de, para) {
        groupList(memory).forEach(group => {
            list(group.membros).forEach(member => {
                if (isObject(member) && normalizeEmail(member.email) === de) member.email = para;
            });
        });
    },
    // Anonimizar: o e-mail do membro vira o do pseudônimo; o id fica (quem estava em que
    // grupo continua contando, sem o nome).
    anonymize(memory, aluno, pseudonimo) {
        const email = normalizeEmail(pseudonimo && pseudonimo.email);
        groupList(memory).forEach(group => {
            const isHis = memberOf(aluno, group);
            list(group.membros).forEach(member => {
                // Como o cadastro anonimizado (que perde o id) e as entregas (studentId null).
                if (isHis(member)) {
                    member.email = email || member.email;
                    member.studentId = null;
                }
            });
        });
    },
    // Apagar de vez: o aluno sai dos grupos (o grupo fica).
    purge(memory, aluno) {
        groupList(memory).forEach(group => {
            const isHis = memberOf(aluno, group);
            if (list(group.membros).some(isHis)) group.membros = list(group.membros).filter(member => !isHis(member));
        });
    },
    // Mesclar: o 'fica' entra nos grupos do 'sai'. Sem duplicar: no grupo em que os dois
    // estão, o 'sai' só sai; num conjunto em que o 'fica' já tem outro grupo ativo, o
    // 'sai' sai do grupo dele (a regra de um grupo por conjunto continua valendo) e o
    // grupo leva mergedFrom.
    merge(memory, fica, sai) {
        const target = normalizeEmail(fica && fica.email);
        if (!target) return;
        const at = Date.now();
        groupList(memory).forEach(group => {
            const isSai = memberOf(sai, group);
            if (!list(group.membros).some(isSai)) return;
            const read = readGroup(group);
            const key = { courseId: read.courseId, studentClass: read.studentClass };
            const inGroup = memberEmailsOf(group).includes(target);
            const otherInSet = !isGroupArchived(group) && groupOfInSet(memory, key, read.conjunto, target, group.id);
            const record = list(group.membros).find(isSai);
            if (inGroup || otherInSet) {
                group.membros = list(group.membros).filter(member => !isSai(member));
                group.mergedFrom = [...list(group.mergedFrom), { studentEmail: normalizeEmail(record && record.email) || null, studentId: (sai && sai.id) || null, at }];
                return;
            }
            list(group.membros).forEach(member => {
                if (!isSai(member)) return;
                member.email = target;
                member.studentId = (fica && fica.id) || member.studentId || null;
            });
        });
    },
    relink(memory, idsPorEmail) {
        let changed = false;
        groupList(memory).forEach(group => {
            if (relinkRecordsByEmail(memory, list(group.membros), idsPorEmail, { emailField: 'email', idField: 'studentId' })) changed = true;
        });
        return changed;
    },
    count(memory, aluno) {
        return groupList(memory).filter(group => list(group.membros).some(memberOf(aluno, group))).length;
    },
    // Meus dados: os grupos do aluno (nome, conjunto, tipo, turma, quando entrou), sem os
    // colegas. O administrador vê também quem incluiu.
    exportSection(memory, aluno, audience) {
        const rows = [];
        groupList(memory).forEach(group => {
            const record = list(group.membros).find(memberOf(aluno, group));
            if (!record) return;
            const read = readGroup(group);
            const row = {
                grupo: read.nome,
                conjunto: read.conjunto,
                tipo: TYPE_LABELS[read.tipo],
                curso: read.courseId,
                turma: read.studentClass,
                entrouEm: msOrNull(record.adicionadoEm),
                situacao: read.arquivadoEm !== null ? 'Arquivado' : 'Ativo',
            };
            if (audience === 'admin') {
                row.groupId = read.id;
                row.incluidoPor = typeof record.adicionadoPor === 'string' ? record.adicionadoPor : null;
            }
            rows.push(row);
        });
        return rows.length ? rows : undefined;
    },
    printColumns: [
        { field: 'grupo', label: 'Grupo', format: 'text' },
        { field: 'conjunto', label: 'Conjunto', format: 'text' },
        { field: 'tipo', label: 'Tipo', format: 'text' },
        { field: 'turma', label: 'Turma', format: 'text' },
        { field: 'entrouEm', label: 'Entrou em', format: 'datetime' },
        { field: 'situacao', label: 'Situação', format: 'text' },
    ],
});

module.exports = {
    SCHEMA_VERSION,
    GROUP_TYPES,
    TYPE_LABELS,
    DRAW_CRITERIA,
    DEFAULT_SET,
    LIMITS,
    GROUP_ID_PATTERN,
    activeGroupsForClass,
    findGroup,
    groupsOfStudent,
    groupMemberEmails,
    groupsForClass,
    isGroupArchived,
    classOfGroup,
    classRoster,
    classGroupsView,
    studentGroupsView,
    presentGroup,
    createGroup,
    updateGroup,
    archiveGroup,
    restoreGroup,
    cleanReason,
    drawProposal,
    confirmDraw,
    replaceGroupsWithPrefix,
    isGroupReleaseKey,
    activeGroupInClass,
    studentGroupIdsInClass,
    groupTargetReaches,
    groupReleasedItemsFor,
    clearGroupReleasesOf,
    groupReleasesView,
    setGroupRelease,
    groupOptionsForClass,
    groupLabel,
};
