// ---------------------------------------------------------------------------
// Conversas entre aluno e instrutor (fase 3, P5-S7a, FUN-14; D8 a D15 do P5, contratos
// C6, C7 e C9). As conversas e as mensagens são lidas e gravadas só por aqui; as rotas
// (routes/studentMessages.js e routes/adminMessages.js) cuidam da entrada, da sessão, do
// escopo, dos limites de envio, da auditoria e da gravação.
//
// Formato das linhas (modelo_de_dados do P5):
// - conversations: { id: 'conv_<ms>_<6 hex>', schemaVersion: 1, courseId, studentClass,
//   aluno: { email (minúsculo), studentId | null }, instrutor: { email, nome (cópia na
//   criação) }, assunto (0-120), status: 'aberta' | 'encerrada', iniciadaPor: 'aluno' |
//   'instrutor', criadaEm, ultimaMensagemEm, mensagens (quantas), lidaAte: { aluno: ms,
//   instrutor: ms }, ultimaDoAlunoEm, ultimaDoInstrutorEm (ms ou null: o sino e a fila
//   não precisam ler as mensagens), arquivadaPeloAlunoEm: ms | null, encerradaEm?,
//   encerradaPor?, motivoEncerramento? (0-200), reabertaEm?, reabertaPor? };
// - conversationMessages (append: uma linha por mensagem, nunca editada): { id:
//   'msg_<ms>_<6 hex>', schemaVersion: 1, conversationId, autor: 'aluno' | 'instrutor',
//   autorEmail, texto (1-2000, sem caracteres de controle), criadaEm (ms) }.
// Leitura tolerante: campo ausente vale o padrão, sem reescrever a linha (as tabelas
// nascem vazias pelo registro, missing 'keep'; nenhuma migração).
//
// Regras:
// - conversa 1 a 1 entre um aluno e um instrutor, sempre numa turma (D8). Os dois lados
//   começam; o aluno escolhe o instrutor numa lista dos que atendem a turma (page.messages,
//   turma no escopo, conta que não é só de consulta e preferência messages.receive
//   ligada), por um identificador opaco (HMAC do e-mail com a turma, chave do processo):
//   nada de e-mail de professor no portal. Uma conversa aberta por aluno x instrutor x
//   turma: começar de novo com uma aberta junta a mensagem nela;
// - só texto, 1 a 2000 caracteres depois de tirar os caracteres de controle (quebra de
//   linha e tabulação ficam); assunto opcional até 120. Mensagem não se edita nem se
//   apaga (D9). Dentro de uma conversa o carimbo criadaEm só cresce (duas mensagens no
//   mesmo milissegundo ficam 1 ms uma depois da outra), para o "depois de" da consulta
//   a cada 10 s nunca perder uma;
// - aluno com tentativa de prova aberta não envia (C9, studentHasOpenAttempt): 409
//   exam_in_progress. O instrutor pode escrever; o aluno lê depois;
// - o instrutor encerra (motivo opcional) e reabre; encerrada, o aluno lê e não responde
//   (409 conversation_closed) e pode começar outra; o instrutor ainda pode escrever. O
//   aluno arquiva para si; mensagem nova (de qualquer lado) tira do arquivo (D14);
// - marcas de leitura por lado (lidaAte); a mensagem de quem escreve já conta como lida
//   para ele. "Marcar como lidas" do sino não mexe aqui (C7);
// - quem lê: os dois participantes. O administrador pleno (messages.readAll, resposta do
//   Alan à pergunta 4: "Sim, com registro") abre qualquer conversa; a abertura fica na
//   auditoria (conversation_read_by_admin, uma vez por dia e conversa) e as duas telas
//   mostram READ_NOTICE.
// Sino do aluno ('mensagem:<id>', uma por conversa com mensagem do instrutor que ele não
// leu) e fila do instrutor ('mensagens': conversas dele com mensagem nova de aluno):
// provedores de utils/studentFeeds.js (C7). Ciclo de vida do aluno: handler
// 'conversations' em utils/studentDataHandlers.js (troca de e-mail, anonimizar, apagar de
// vez, mesclar, religar, contar e Meus dados).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { normalizeEmail, displayName, studentInClass, isClosedStudentStatus, isAnonymizedStudent } = require('./students.js');
const { publicStudentEmail, findStudentById } = require('./studentIdentity.js');
const { canAccessAdminPermission } = require('./adminPermissions.js');
const { isReadOnlyAccount, accountRoleLabel } = require('./adminRoles.js');
const { isCourseDeleted } = require('./contentAccess.js');
const { compareText, compareOrdinal } = require('./textSearch.js');
const { registerStudentDataHandler, relinkRecordsByEmail, mergeOwnedRecords } = require('./studentDataHandlers.js');
const studentFeeds = require('./studentFeeds.js');

const SCHEMA_VERSION = 1;
const STATUSES = Object.freeze(['aberta', 'encerrada']);
const AUTHORS = Object.freeze(['aluno', 'instrutor']);
const LIMITS = Object.freeze({
    textMax: 2000,
    subjectMax: 120,
    reasonMax: 200,
    pageSize: 200,
    // D12: por conta (e-mail), não por IP.
    studentMessages: Object.freeze({ max: 20, windowMs: 10 * 60 * 1000 }),
    studentNewConversations: Object.freeze({ max: 5, windowMs: 24 * 60 * 60 * 1000 }),
    instructorNewConversations: Object.freeze({ max: 60, windowMs: 60 * 60 * 1000 }),
});
const MESSAGE_PERMISSION = 'page.messages';
const READ_ALL_PERMISSION = 'messages.readAll';
const RECEIVE_PREFERENCE = 'messages.receive';
const READ_NOTICE = 'O administrador da escola pode ler estas mensagens.';
const KEEP_NOTICE = 'As mensagens ficam guardadas e não podem ser apagadas.';
const EXAM_IN_PROGRESS = Object.freeze({ code: 'exam_in_progress', error: 'Durante a prova, fale com o professor pelo botão da prova.' });
const ANONYMIZED_MESSAGE = '[mensagem removida na anonimização]';
const ANONYMIZED_CLOSE_REASON = 'Cadastro do aluno anonimizado';
const STUDENT_INACTIVE = Object.freeze({ code: 'student_inactive', error: 'O cadastro deste aluno está encerrado. A conversa fica só para consulta.' });
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

// Chave dos identificadores opacos dos professores (destinatário do aluno). Só do processo:
// nunca vai para o banco (a rota que lista não grava) e muda a cada reinício; um
// formulário aberto antes do reinício recebe 400 e escolhe de novo.
const RECIPIENT_SECRET = crypto.randomBytes(32);

function list(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function msOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cleanLine(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// Texto da mensagem: quebras de linha viram \n, caracteres de controle saem (fica a
// tabulação e a quebra de linha), espaços nas pontas também. Mais de duas linhas em branco
// seguidas viram duas.
function cleanMessageText(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u2028\u2029\ufeff]/g, '')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function conversationList(memory) {
    return list(memory && memory.conversations).filter(isObject);
}

function messageList(memory) {
    return list(memory && memory.conversationMessages).filter(isObject);
}

function ensureLists(memory) {
    if (!Array.isArray(memory.conversations)) memory.conversations = [];
    if (!Array.isArray(memory.conversationMessages)) memory.conversationMessages = [];
}

function newId(prefix, now, taken) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const id = `${prefix}_${now}_${crypto.randomBytes(3).toString('hex')}`;
        if (!taken || !taken(id)) return id;
    }
    return `${prefix}_${now}_${crypto.randomBytes(6).toString('hex')}`;
}

function failure(status, error, extra = {}) {
    return { ok: false, status, error, ...extra };
}

// ------------------------------------------------------------ leitura
// Linha lida com os padrões (sem mexer na gravada).
function readConversation(conv) {
    const aluno = isObject(conv.aluno) ? conv.aluno : {};
    const instrutor = isObject(conv.instrutor) ? conv.instrutor : {};
    const lidaAte = isObject(conv.lidaAte) ? conv.lidaAte : {};
    return {
        id: String(conv.id || ''),
        courseId: String(conv.courseId || ''),
        studentClass: String(conv.studentClass || ''),
        aluno: {
            email: normalizeEmail(aluno.email),
            studentId: typeof aluno.studentId === 'string' && aluno.studentId ? aluno.studentId : null,
        },
        instrutor: {
            email: normalizeEmail(instrutor.email),
            nome: cleanLine(instrutor.nome),
        },
        assunto: cleanLine(conv.assunto).slice(0, LIMITS.subjectMax),
        // Falha fechada: status estranho conta como encerrada (o aluno não escreve).
        status: conv.status === 'aberta' ? 'aberta' : 'encerrada',
        iniciadaPor: conv.iniciadaPor === 'instrutor' ? 'instrutor' : 'aluno',
        criadaEm: msOrNull(conv.criadaEm) ?? 0,
        ultimaMensagemEm: msOrNull(conv.ultimaMensagemEm) ?? msOrNull(conv.criadaEm) ?? 0,
        mensagens: Number.isSafeInteger(conv.mensagens) && conv.mensagens > 0 ? conv.mensagens : 0,
        lidaAte: { aluno: msOrNull(lidaAte.aluno) ?? 0, instrutor: msOrNull(lidaAte.instrutor) ?? 0 },
        ultimaDoAlunoEm: msOrNull(conv.ultimaDoAlunoEm),
        ultimaDoInstrutorEm: msOrNull(conv.ultimaDoInstrutorEm),
        arquivadaPeloAlunoEm: msOrNull(conv.arquivadaPeloAlunoEm),
        encerradaEm: msOrNull(conv.encerradaEm),
        encerradaPor: typeof conv.encerradaPor === 'string' ? conv.encerradaPor : null,
        motivoEncerramento: cleanLine(conv.motivoEncerramento).slice(0, LIMITS.reasonMax),
        reabertaEm: msOrNull(conv.reabertaEm),
    };
}

function readMessage(msg) {
    return {
        id: String(msg.id || ''),
        conversationId: String(msg.conversationId || ''),
        autor: msg.autor === 'instrutor' ? 'instrutor' : 'aluno',
        autorEmail: normalizeEmail(msg.autorEmail),
        texto: typeof msg.texto === 'string' ? msg.texto : '',
        criadaEm: msOrNull(msg.criadaEm) ?? 0,
    };
}

// A conversa deste id, ou null.
function findConversation(memory, id) {
    if (typeof id !== 'string' || !CONVERSATION_ID_PATTERN.test(id)) return null;
    return conversationList(memory).find(conv => String(conv.id) === id) || null;
}

// Turma da conversa em memory.classes, com o curso (null se a turma não existe mais ou o
// curso foi excluído).
function conversationClass(memory, conv) {
    if (!conv) return null;
    const read = readConversation(conv);
    const course = list(memory && memory.courses).find(item => item && String(item.id) === read.courseId);
    if (!course || isCourseDeleted(course)) return null;
    return list(memory && memory.classes).find(cls => cls
        && String(cls.courseId || '') === read.courseId
        && String(cls.name || '') === read.studentClass) || null;
}

function isStudentOf(conv, email) {
    const wanted = normalizeEmail(email);
    return !!wanted && !!conv && normalizeEmail(isObject(conv.aluno) ? conv.aluno.email : '') === wanted;
}

function isInstructorOf(conv, email) {
    const wanted = normalizeEmail(email);
    return !!wanted && !!conv && normalizeEmail(isObject(conv.instrutor) ? conv.instrutor.email : '') === wanted;
}

// Mensagens da conversa em ordem de envio (criadaEm e, no empate, a ordem gravada).
function messagesOf(memory, conversationId) {
    const wanted = String(conversationId || '');
    return messageList(memory)
        .map((msg, index) => ({ msg, index }))
        .filter(({ msg }) => String(msg.conversationId || '') === wanted)
        .sort((a, b) => (msOrNull(a.msg.criadaEm) ?? 0) - (msOrNull(b.msg.criadaEm) ?? 0) || a.index - b.index)
        .map(({ msg }) => msg);
}

// Não lidas de um lado ('aluno' ou 'instrutor') de várias conversas, numa passada só:
// mensagens do outro lado depois da marca lidaAte daquele lado. Map(id -> número).
function unreadCounts(memory, conversations, side) {
    const marks = new Map();
    list(conversations).forEach(conv => {
        const read = readConversation(conv);
        marks.set(read.id, read.lidaAte[side] || 0);
    });
    const out = new Map([...marks.keys()].map(id => [id, 0]));
    if (!marks.size) return out;
    messageList(memory).forEach(msg => {
        const id = String(msg.conversationId || '');
        if (!marks.has(id)) return;
        const read = readMessage(msg);
        if (read.autor === side) return;
        if (read.criadaEm > marks.get(id)) out.set(id, out.get(id) + 1);
    });
    return out;
}

// Há mensagem do outro lado depois da marca? (sem ler as mensagens; linha antiga sem
// ultimaDo* cai na contagem.)
function hasUnread(memory, conv, side) {
    const read = readConversation(conv);
    const other = side === 'aluno' ? read.ultimaDoInstrutorEm : read.ultimaDoAlunoEm;
    if (other !== null) return other > (read.lidaAte[side] || 0);
    return (unreadCounts(memory, [conv], side).get(read.id) || 0) > 0;
}

// ------------------------------------------------------------ instrutores
// Lazy: middlewares.js depende deste módulo (escopo de /conversations/:id).
function canAccessClass(account, cls) {
    return require('../middlewares.js').adminCanAccessClass(account, cls.name, cls.courseId);
}

function instructorAccount(memory, email) {
    const wanted = normalizeEmail(email);
    if (!wanted) return null;
    return list(memory && memory.admins).find(account => account && normalizeEmail(account.email) === wanted) || null;
}

function receivesMessages(account) {
    const prefs = account && isObject(account.preferences) ? account.preferences : {};
    return prefs[RECEIVE_PREFERENCE] !== false;
}

// O instrutor ainda atende a turma pelas mensagens? (conta existe, tem page.messages, não é
// só de consulta e a turma está no escopo.) A preferência só vale para conversa nova.
function instructorServesClass(account, cls) {
    return !!account && !!cls && canAccessAdminPermission(account, MESSAGE_PERMISSION)
        && !isReadOnlyAccount(account) && canAccessClass(account, cls);
}

function instructorName(account) {
    return cleanLine(account && account.name) || normalizeEmail(account && account.email);
}

function recipientRef(cls, email) {
    return crypto.createHmac('sha256', RECIPIENT_SECRET)
        .update(`${String(cls.courseId || '')}\n${String(cls.name || '')}\n${normalizeEmail(email)}`)
        .digest('hex')
        .slice(0, 32);
}

// Instrutores que o aluno pode escolher na turma, por nome: { ref, nome, papel, account }.
function classRecipients(memory, cls) {
    if (!cls) return [];
    const seen = new Set();
    return list(memory && memory.admins)
        .filter(account => {
            const email = normalizeEmail(account && account.email);
            if (!email || seen.has(email)) return false;
            seen.add(email);
            return instructorServesClass(account, cls) && receivesMessages(account);
        })
        .map(account => ({ ref: recipientRef(cls, account.email), nome: instructorName(account), papel: accountRoleLabel(account), account }))
        .sort((a, b) => compareText(a.nome, b.nome) || compareOrdinal(a.ref, b.ref));
}

function findRecipient(memory, cls, ref) {
    const wanted = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{32}$/.test(wanted)) return null;
    return classRecipients(memory, cls).find(item => item.ref === wanted) || null;
}

// ------------------------------------------------------------ alunos
function studentsByEmail(memory) {
    const map = new Map();
    list(memory && memory.students).forEach(student => {
        const email = normalizeEmail(student && student.email);
        if (email && !map.has(email)) map.set(email, student);
    });
    return map;
}

// Cadastro ativo: existe, não foi anonimizado nem desligado (Inativo, Concluído,
// Transferido, Evadido).
function isActiveStudentRecord(student) {
    return !!student && !isAnonymizedStudent(student) && !isClosedStudentStatus(student.status);
}

// O cadastro do aluno da conversa (pelo e-mail da conversa, que a troca de e-mail
// acompanha; sem ele, pelo studentId), ou null. students: mapa e-mail -> aluno já montado.
function conversationStudent(memory, conv, students = null) {
    const read = readConversation(conv);
    const byEmail = students ? students.get(read.aluno.email) : studentsByEmail(memory).get(read.aluno.email);
    if (byEmail) return byEmail;
    return read.aluno.studentId ? (findStudentById(memory, read.aluno.studentId) || null) : null;
}

// O aluno da conversa ainda pode receber mensagem do instrutor? Cadastro encerrado ou
// anonimizado: a conversa fica só para consulta (o aluno não entra mais no portal, e o
// texto novo poria de volta o que a anonimização tirou).
function conversationStudentActive(memory, conv, students = null) {
    return isActiveStudentRecord(conversationStudent(memory, conv, students));
}

// Aluno que pode receber conversa nova na turma: matriculado e com o cadastro ativo.
function studentCanTalkInClass(student, cls) {
    return !!cls && isActiveStudentRecord(student) && studentInClass(student, cls.name, cls.courseId);
}

// ------------------------------------------------------------ escrita
// A conversa aberta do par aluno x instrutor na turma, ou null.
function openConversationFor(memory, cls, studentEmail, instructorEmail) {
    studentEmail = normalizeEmail(studentEmail);
    instructorEmail = normalizeEmail(instructorEmail);
    return conversationList(memory).find(conv => {
        const read = readConversation(conv);
        return read.status === 'aberta' && read.courseId === String(cls.courseId || '') && read.studentClass === String(cls.name || '')
            && read.aluno.email === studentEmail && read.instrutor.email === instructorEmail;
    }) || null;
}

function checkText(value) {
    const texto = cleanMessageText(value);
    if (!texto) return failure(400, 'Escreva a mensagem.', { field: 'texto', code: 'empty_message' });
    if (texto.length > LIMITS.textMax) return failure(400, 'A mensagem pode ter no máximo 2.000 caracteres.', { field: 'texto', code: 'message_too_long' });
    return { ok: true, texto };
}

// Acrescenta a mensagem e atualiza a conversa (contagem, carimbos, marca de quem escreve e
// o arquivo do aluno). Devolve a linha gravada.
function appendMessage(memory, conv, { autor, autorEmail, texto, now = Date.now() }) {
    ensureLists(memory);
    const read = readConversation(conv);
    const criadaEm = Math.max(now, read.ultimaMensagemEm + 1);
    const taken = new Set(memory.conversationMessages.map(msg => msg && msg.id));
    const message = {
        id: newId('msg', criadaEm, id => taken.has(id)),
        schemaVersion: SCHEMA_VERSION,
        conversationId: read.id,
        autor,
        autorEmail: normalizeEmail(autorEmail),
        texto,
        criadaEm,
    };
    memory.conversationMessages.push(message);
    conv.mensagens = read.mensagens + 1;
    conv.ultimaMensagemEm = criadaEm;
    if (autor === 'aluno') conv.ultimaDoAlunoEm = criadaEm;
    else conv.ultimaDoInstrutorEm = criadaEm;
    conv.lidaAte = { ...read.lidaAte, [autor]: criadaEm };
    // Linha antiga sem ultimaDo* do outro lado: grava o carimbo da última mensagem dele,
    // para o sino e a fila não precisarem ler as mensagens daqui em diante.
    const other = autor === 'aluno' ? 'ultimaDoInstrutorEm' : 'ultimaDoAlunoEm';
    if (msOrNull(conv[other]) === null) {
        const otherSide = autor === 'aluno' ? 'instrutor' : 'aluno';
        const last = messagesOf(memory, read.id).map(readMessage).filter(item => item.autor === otherSide).pop();
        conv[other] = last ? last.criadaEm : null;
    }
    if (read.arquivadaPeloAlunoEm !== null) conv.arquivadaPeloAlunoEm = null;
    return message;
}

function newConversation(memory, cls, { student, account, assunto, iniciadaPor, now }) {
    ensureLists(memory);
    const taken = new Set(memory.conversations.map(conv => conv && conv.id));
    const conv = {
        id: newId('conv', now, id => taken.has(id)),
        schemaVersion: SCHEMA_VERSION,
        courseId: String(cls.courseId || ''),
        studentClass: String(cls.name || ''),
        aluno: {
            email: normalizeEmail(student.email),
            studentId: typeof student.id === 'string' && student.id ? student.id : null,
        },
        instrutor: { email: normalizeEmail(account.email), nome: instructorName(account) },
        assunto: cleanLine(assunto).slice(0, LIMITS.subjectMax),
        status: 'aberta',
        iniciadaPor,
        criadaEm: now,
        ultimaMensagemEm: now - 1,
        mensagens: 0,
        lidaAte: { aluno: 0, instrutor: 0 },
        ultimaDoAlunoEm: null,
        ultimaDoInstrutorEm: null,
        arquivadaPeloAlunoEm: null,
    };
    memory.conversations.push(conv);
    return conv;
}

// Começa (ou continua, se já há uma aberta com o mesmo par na turma) uma conversa com a
// primeira mensagem. by: 'aluno' | 'instrutor'. student: o cadastro (ou o aluno da
// sessão); account: a conta do instrutor. Devolve { ok, conversation, message, created }.
function startConversation(memory, cls, { by, student, account, assunto, texto, now = Date.now() }) {
    const checked = checkText(texto);
    if (!checked.ok) return checked;
    const studentEmail = normalizeEmail(student && student.email);
    const instructorEmail = normalizeEmail(account && account.email);
    if (!studentEmail || !instructorEmail) return failure(400, 'Conversa sem aluno ou sem professor.');
    let conv = openConversationFor(memory, cls, studentEmail, instructorEmail);
    const created = !conv;
    if (!conv) conv = newConversation(memory, cls, { student, account, assunto, iniciadaPor: by, now });
    else if (!readConversation(conv).assunto && cleanLine(assunto)) conv.assunto = cleanLine(assunto).slice(0, LIMITS.subjectMax);
    const message = appendMessage(memory, conv, {
        autor: by,
        autorEmail: by === 'aluno' ? studentEmail : instructorEmail,
        texto: checked.texto,
        now,
    });
    return { ok: true, conversation: conv, message, created };
}

// Mensagem numa conversa existente. A conversa encerrada recusa o aluno (409
// conversation_closed) e aceita o instrutor; o instrutor é recusado (409
// student_inactive) quando o cadastro do aluno está encerrado ou anonimizado.
function postMessage(memory, conv, { by, email, texto, now = Date.now() }) {
    const read = readConversation(conv);
    if (by === 'aluno' && read.status !== 'aberta') {
        return failure(409, 'O professor encerrou esta conversa. Você pode começar outra.', { code: 'conversation_closed' });
    }
    if (by === 'instrutor' && !conversationStudentActive(memory, conv)) {
        return failure(409, STUDENT_INACTIVE.error, { code: STUDENT_INACTIVE.code });
    }
    const checked = checkText(texto);
    if (!checked.ok) return checked;
    const message = appendMessage(memory, conv, { autor: by, autorEmail: email, texto: checked.texto, now });
    return { ok: true, conversation: conv, message };
}

// Marca de leitura de um lado: até `ate` (ms) ou até a última mensagem; nunca volta para
// trás nem passa da última mensagem. Devolve true quando mudou.
function markRead(conv, side, ate) {
    const read = readConversation(conv);
    const target = Number.isFinite(ate) ? Math.min(ate, read.ultimaMensagemEm) : read.ultimaMensagemEm;
    if (!(target > read.lidaAte[side])) return false;
    conv.lidaAte = { ...read.lidaAte, [side]: target };
    return true;
}

// O aluno arquiva (true) ou tira do arquivo (false) a conversa, só para ele.
function setArchivedByStudent(conv, arquivada, now = Date.now()) {
    const read = readConversation(conv);
    if (arquivada === (read.arquivadaPeloAlunoEm !== null)) return false;
    conv.arquivadaPeloAlunoEm = arquivada ? now : null;
    return true;
}

function closeConversation(conv, { actorEmail, motivo, now = Date.now() }) {
    const read = readConversation(conv);
    if (read.status === 'encerrada') return { ok: true, changed: false };
    conv.status = 'encerrada';
    conv.encerradaEm = now;
    conv.encerradaPor = normalizeEmail(actorEmail) || null;
    conv.motivoEncerramento = cleanLine(motivo).slice(0, LIMITS.reasonMax);
    return { ok: true, changed: true };
}

// Reabrir: recusada (409 conversation_open_exists) se o mesmo par já tem outra aberta na
// turma (uma aberta por aluno x instrutor x turma) e (409 student_inactive) se o cadastro
// do aluno está encerrado ou anonimizado.
function reopenConversation(memory, conv, { actorEmail, now = Date.now() }) {
    const read = readConversation(conv);
    if (read.status === 'aberta') return { ok: true, changed: false };
    if (!conversationStudentActive(memory, conv)) return failure(409, STUDENT_INACTIVE.error, { code: STUDENT_INACTIVE.code });
    const other = conversationList(memory).find(item => item !== conv && (() => {
        const r = readConversation(item);
        return r.status === 'aberta' && r.courseId === read.courseId && r.studentClass === read.studentClass
            && r.aluno.email === read.aluno.email && r.instrutor.email === read.instrutor.email;
    })());
    if (other) {
        return failure(409, 'Este aluno já tem outra conversa aberta com você nesta turma. Continue por ela.', { code: 'conversation_open_exists', conversationId: String(other.id) });
    }
    conv.status = 'aberta';
    conv.reabertaEm = now;
    conv.reabertaPor = normalizeEmail(actorEmail) || null;
    return { ok: true, changed: true };
}

// ------------------------------------------------------------ apresentação
function courseName(memory, courseId) {
    const course = list(memory && memory.courses).find(item => item && String(item.id) === String(courseId));
    return (course && cleanLine(course.name)) || String(courseId || '');
}

function instructorLabel(memory, read) {
    const account = instructorAccount(memory, read.instrutor.email);
    return (account && instructorName(account)) || read.instrutor.nome || 'Professor';
}

// Sem o cadastro ao lado e com o e-mail do pseudônimo (backup de antes da anonimização
// restaurado): o nome do pseudônimo, nunca o endereço interno (carga na hora, como no
// scrubberFor).
function studentLabel(student, email) {
    if (student && displayName(student)) return displayName(student);
    const pseudonym = require('./studentLifecycle.js').pseudonymNameFromEmail(email);
    return pseudonym || publicStudentEmail(email) || 'Aluno';
}

// Conversa na lista do portal.
function studentConversationView(memory, conv, naoLidas = 0) {
    const read = readConversation(conv);
    return {
        id: read.id,
        courseId: read.courseId,
        studentClass: read.studentClass,
        assunto: read.assunto,
        instrutor: { nome: instructorLabel(memory, read) },
        status: read.status,
        iniciadaPor: read.iniciadaPor === 'aluno' ? 'voce' : 'instrutor',
        criadaEm: read.criadaEm,
        ultimaMensagemEm: read.ultimaMensagemEm,
        mensagens: read.mensagens,
        naoLidas,
        arquivada: read.arquivadaPeloAlunoEm !== null,
        encerradaEm: read.encerradaEm,
    };
}

// A conversa na lista do portal, com as não lidas dela.
function studentConversationSummary(memory, conv) {
    return studentConversationView(memory, conv, unreadCounts(memory, [conv], 'aluno').get(String(conv.id)) || 0);
}

// Conversas do aluno na turma (as arquivadas só com arquivadas), da mais recente.
function studentConversations(memory, cls, email, { arquivadas = false } = {}) {
    const wanted = normalizeEmail(email);
    const rows = conversationList(memory).filter(conv => {
        const read = readConversation(conv);
        return read.aluno.email === wanted && read.courseId === String(cls.courseId || '') && read.studentClass === String(cls.name || '')
            && (arquivadas ? read.arquivadaPeloAlunoEm !== null : read.arquivadaPeloAlunoEm === null);
    });
    const unread = unreadCounts(memory, rows, 'aluno');
    return rows
        .map(conv => studentConversationView(memory, conv, unread.get(String(conv.id)) || 0))
        .sort((a, b) => b.ultimaMensagemEm - a.ultimaMensagemEm || compareOrdinal(a.id, b.id));
}

// Página de mensagens: depois de `depois` (ms; todas as novas, para a consulta a cada
// 10 s), ou as últimas LIMITS.pageSize antes de `antes` (ou do fim).
function pageOfMessages(memory, conv, { depois = null, antes = null } = {}) {
    const all = messagesOf(memory, String(conv.id)).map(readMessage);
    if (Number.isFinite(depois)) return { items: all.filter(msg => msg.criadaEm > depois), temAnteriores: false };
    const before = Number.isFinite(antes) ? all.filter(msg => msg.criadaEm < antes) : all;
    const items = before.slice(-LIMITS.pageSize);
    return { items, temAnteriores: before.length > items.length };
}

function studentMessagesView(memory, conv, options = {}) {
    const read = readConversation(conv);
    const page = pageOfMessages(memory, conv, options);
    const nome = instructorLabel(memory, read);
    return {
        conversa: { ...studentConversationView(memory, conv, unreadCounts(memory, [conv], 'aluno').get(read.id) || 0), lidaAte: read.lidaAte.aluno },
        mensagens: page.items.map(msg => ({
            id: msg.id,
            autor: msg.autor === 'aluno' ? 'voce' : 'instrutor',
            nome: msg.autor === 'aluno' ? 'Você' : nome,
            texto: msg.texto,
            criadaEm: msg.criadaEm,
        })),
        temAnteriores: page.temAnteriores,
    };
}

// Conversa na lista do painel. participante: quem vê é o instrutor da conversa (só ele
// tem não lidas e escreve).
function adminConversationView(memory, conv, viewerEmail, { naoLidas = 0, students = studentsByEmail(memory) } = {}) {
    const read = readConversation(conv);
    const student = conversationStudent(memory, conv, students);
    const participante = read.instrutor.email === normalizeEmail(viewerEmail);
    return {
        id: read.id,
        courseId: read.courseId,
        curso: courseName(memory, read.courseId),
        studentClass: read.studentClass,
        aluno: {
            nome: studentLabel(student, read.aluno.email),
            email: publicStudentEmail(read.aluno.email),
            matricula: student && student.matricula ? String(student.matricula) : '',
            studentId: read.aluno.studentId || (student && typeof student.id === 'string' ? student.id : null),
            // false: cadastro encerrado ou anonimizado; o instrutor só consulta (sem
            // responder nem reabrir).
            ativo: isActiveStudentRecord(student),
        },
        instrutor: { nome: instructorLabel(memory, read), email: read.instrutor.email },
        assunto: read.assunto,
        status: read.status,
        iniciadaPor: read.iniciadaPor,
        criadaEm: read.criadaEm,
        ultimaMensagemEm: read.ultimaMensagemEm,
        mensagens: read.mensagens,
        naoLidas: participante ? naoLidas : 0,
        participante,
        encerradaEm: read.encerradaEm,
        motivoEncerramento: read.motivoEncerramento,
    };
}

// Conversas que o painel lista: as do instrutor (all false) ou todas da escola (all true,
// só com messages.readAll), filtradas por curso, turma e situação, da mais recente.
// Conversa de curso excluído ou turma que não existe mais fica de fora.
function adminConversations(memory, viewer, { courseId = '', studentClass = '', status = '', all = false, canSeeClass = () => true } = {}) {
    const viewerEmail = normalizeEmail(viewer && viewer.email);
    const rows = conversationList(memory).filter(conv => {
        const read = readConversation(conv);
        if (!all && read.instrutor.email !== viewerEmail) return false;
        if (courseId && read.courseId !== courseId) return false;
        if (studentClass && read.studentClass !== studentClass) return false;
        if (status && read.status !== status) return false;
        const cls = conversationClass(memory, conv);
        return !!cls && canSeeClass(cls);
    });
    const unread = unreadCounts(memory, rows.filter(conv => isInstructorOf(conv, viewerEmail)), 'instrutor');
    const students = studentsByEmail(memory);
    return rows
        .map(conv => adminConversationView(memory, conv, viewerEmail, { naoLidas: unread.get(String(conv.id)) || 0, students }))
        .sort((a, b) => b.ultimaMensagemEm - a.ultimaMensagemEm || compareOrdinal(a.id, b.id));
}

function adminMessagesView(memory, conv, viewerEmail, options = {}) {
    const read = readConversation(conv);
    const page = pageOfMessages(memory, conv, options);
    const students = studentsByEmail(memory);
    const alunoNome = studentLabel(students.get(read.aluno.email) || null, read.aluno.email);
    const instrutorNome = instructorLabel(memory, read);
    const participante = isInstructorOf(conv, viewerEmail);
    const naoLidas = participante ? (unreadCounts(memory, [conv], 'instrutor').get(read.id) || 0) : 0;
    return {
        conversa: { ...adminConversationView(memory, conv, viewerEmail, { naoLidas, students }), lidaAte: read.lidaAte.instrutor },
        mensagens: page.items.map(msg => ({
            id: msg.id,
            autor: msg.autor,
            nome: msg.autor === 'aluno' ? alunoNome : instrutorNome,
            voce: participante && msg.autor === 'instrutor',
            texto: msg.texto,
            criadaEm: msg.criadaEm,
        })),
        temAnteriores: page.temAnteriores,
    };
}

function messageView(msg, { forStudent = false, nome = '' } = {}) {
    const read = readMessage(msg);
    if (forStudent) return { id: read.id, autor: read.autor === 'aluno' ? 'voce' : 'instrutor', nome: read.autor === 'aluno' ? 'Você' : nome, texto: read.texto, criadaEm: read.criadaEm };
    return { id: read.id, autor: read.autor, nome, voce: read.autor === 'instrutor', texto: read.texto, criadaEm: read.criadaEm };
}

// ------------------------------------------------------------ sino e fila (C7)
const FEED_ID = 'mensagens';

// Sino do aluno: uma linha por conversa da turma com mensagem do instrutor que ele ainda
// não leu (pela marca lidaAte, não pelo "Marcar como lidas" do sino). A prévia não tem.
function notificationItems(ctx) {
    const cls = ctx && ctx.cls;
    const student = ctx && ctx.student;
    if (!cls || (student && student.preview)) return [];
    const email = normalizeEmail(ctx.email);
    return conversationList(ctx.memory)
        .filter(conv => {
            const read = readConversation(conv);
            return read.aluno.email === email && read.courseId === String(cls.courseId || '') && read.studentClass === String(cls.name || '')
                && hasUnread(ctx.memory, conv, 'aluno');
        })
        .map(conv => {
            const read = readConversation(conv);
            const nome = instructorLabel(ctx.memory, read);
            return {
                id: `mensagem:${read.id}`,
                type: 'mensagem',
                title: `Mensagem de ${nome}`,
                text: read.assunto || 'Conversa sem assunto',
                at: read.ultimaDoInstrutorEm || read.ultimaMensagemEm,
                href: `/aluno/mensagens?c=${encodeURIComponent(read.id)}`,
                unread: true,
            };
        });
}

// Fila do instrutor ('Precisa de você' e sino do painel): quantas conversas DELE (quem vê,
// ctx.viewer) têm mensagem nova de aluno, na turma do contexto (ou no curso, ou em todas,
// sem turma). Só para quem tem page.messages (a fila filtra pela permissão).
function queueItems(ctx) {
    const viewerEmail = normalizeEmail(ctx && ctx.viewer && ctx.viewer.email);
    if (!viewerEmail) return [];
    const cls = ctx.cls;
    const course = ctx.course;
    const pending = conversationList(ctx.memory).filter(conv => {
        const read = readConversation(conv);
        if (read.instrutor.email !== viewerEmail) return false;
        if (cls && (read.courseId !== String(cls.courseId || '') || read.studentClass !== String(cls.name || ''))) return false;
        if (!cls && course && read.courseId !== String(course.id || '')) return false;
        // Turma apagada ou que saiu do escopo dele: a conversa não abre, não entra na conta.
        const convClass = conversationClass(ctx.memory, conv);
        if (!convClass || !canAccessClass(ctx.viewer, convClass)) return false;
        return hasUnread(ctx.memory, conv, 'instrutor');
    });
    if (!pending.length) return [];
    const count = pending.length;
    const latest = Math.max(...pending.map(conv => readConversation(conv).ultimaDoAlunoEm || readConversation(conv).ultimaMensagemEm));
    const item = {
        id: 'mensagens',
        tipo: 'mensagens',
        titulo: count === 1 ? '1 conversa com mensagem nova' : `${count} conversas com mensagem nova`,
        detalhe: 'mensagens de alunos esperando resposta · Mensagens',
        count,
        tone: 'info',
        href: '/mensagens',
        permissao: MESSAGE_PERMISSION,
        // Responder é ação: a conta só de consulta não recebe o item.
        somenteQuemAltera: true,
    };
    if (latest > 0) item.at = latest;
    return [item];
}

studentFeeds.registerStudentNotificationProvider({ id: FEED_ID, items: notificationItems });
studentFeeds.registerInstructorQueueProvider({ id: FEED_ID, items: queueItems });

// ------------------------------------------------------------ ciclo de vida do aluno
// A conversa é do aluno? (o e-mail no período em que foi dele, como as outras coleções.)
function ownedBy(aluno) {
    return conv => isObject(conv) && isObject(conv.aluno) && !!conv.aluno.email
        && aluno.owns(conv.aluno.email, { timestamp: msOrNull(conv.criadaEm) ?? undefined }, 'renamed');
}

function idsOf(conversations) {
    return new Set(conversations.map(conv => String(conv.id)));
}

// Partículas do nome que não identificam ninguém e são palavras comuns ("dos alunos").
const NAME_PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'del', 'della', 'der', 'di', 'du', 'e', 'la', 'le', 'van', 'von', 'y']);

function foldWord(value) {
    return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// O nome completo, o nome social e cada parte deles com 3 letras ou mais (menos as
// partículas): na conversa o professor chama o aluno pelo primeiro nome ("Oi Ana") ou só
// pelo sobrenome. O sobrenome com hífen entra inteiro ("Souza-Lima") e também por partes
// ("Souza", "Lima"): a borda do scrubReason não aceita hífen colado no termo, então só as
// partes não tiram o "Souza-Lima" do texto. Palavra comum igual a uma parte do nome também
// sai (preferimos tirar a mais do que deixar o nome).
function nameTerms(values) {
    const out = new Set();
    const addWord = part => {
        const word = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (Array.from(word).length >= 3 && !NAME_PARTICLES.has(foldWord(word))) out.add(word);
    };
    values.forEach(value => {
        const full = cleanLine(value);
        if (!full) return;
        out.add(full);
        full.split(/\s+/).forEach(addWord);
        full.split(/[\s-]+/).forEach(addWord);
    });
    return [...out];
}

// O texto do instrutor sem o nome (inteiro e por partes, com ou sem acento), o e-mail e a
// matrícula do aluno (scrubReason da anonimização; carga na hora porque studentLifecycle.js
// depende dos handlers).
function scrubberFor(aluno) {
    const { scrubReason } = require('./studentLifecycle.js');
    const student = isObject(aluno && aluno.student) ? aluno.student : {};
    const names = nameTerms([student.name, student.nomeSocial]);
    const matriculas = [student.matricula].filter(Boolean);
    const emails = [...new Set([...(aluno.emails || []), aluno.email].filter(Boolean))];
    return text => scrubReason(text, { emails, names, matriculas, replacement: 'aluno', foldAccents: true });
}

// Motivos e textos das conversas na trilha (conversation_*): saem com o aluno.
function scrubConversationAudit(memory, ids, scrub) {
    if (!ids.size || !Array.isArray(memory.auditLogs)) return;
    memory.auditLogs.forEach((entry, index) => {
        if (!isObject(entry) || !/^conversation_/.test(String(entry.action || ''))) return;
        const details = isObject(entry.details) ? entry.details : null;
        if (!details || !ids.has(String(details.conversationId || ''))) return;
        if (typeof details.motivo !== 'string' || !details.motivo) return;
        memory.auditLogs[index] = { ...entry, details: { ...details, motivo: scrub ? scrub(details.motivo) : '(texto removido)' } };
    });
}

function exportRows(memory, aluno, audience) {
    const isHis = ownedBy(aluno);
    const conversations = conversationList(memory).filter(isHis);
    if (!conversations.length) return [];
    const rows = [];
    conversations
        .slice()
        .sort((a, b) => (msOrNull(a.criadaEm) ?? 0) - (msOrNull(b.criadaEm) ?? 0))
        .forEach(conv => {
            const read = readConversation(conv);
            const nome = read.instrutor.nome || instructorLabel(memory, read);
            messagesOf(memory, read.id).map(readMessage).forEach(msg => {
                const row = {
                    conversa: read.assunto || '(sem assunto)',
                    curso: read.courseId,
                    turma: read.studentClass,
                    professor: nome,
                    situacao: read.status === 'aberta' ? 'Aberta' : 'Encerrada',
                    autor: msg.autor === 'aluno' ? (audience === 'admin' ? 'Aluno' : 'Você') : 'Professor',
                    mensagem: msg.texto,
                    enviadaEm: msg.criadaEm,
                };
                if (audience === 'admin') {
                    row.conversationId = read.id;
                    row.professorEmail = read.instrutor.email;
                }
                rows.push(row);
            });
        });
    return rows;
}

registerStudentDataHandler({
    collection: 'conversations',
    label: 'Conversas com professores',
    exportKey: 'conversas',
    // Troca de e-mail: o aluno da conversa e o autor das mensagens dele.
    rename(memory, de, para) {
        const ids = new Set();
        conversationList(memory).forEach(conv => {
            if (isObject(conv.aluno) && normalizeEmail(conv.aluno.email) === de) {
                conv.aluno.email = para;
                ids.add(String(conv.id));
            }
        });
        messageList(memory).forEach(msg => {
            if (msg.autor === 'aluno' && ids.has(String(msg.conversationId || '')) && normalizeEmail(msg.autorEmail) === de) msg.autorEmail = para;
        });
    },
    // Anonimizar: a conversa fica (o professor não perde o histórico), com o pseudônimo no
    // lugar do aluno; o texto do aluno sai, e o do professor e o assunto ficam sem o nome
    // (inteiro e por partes), o e-mail e a matrícula dele. O assunto escrito pelo aluno sai
    // inteiro. A aberta é encerrada pelo sistema: ninguém escreve mais nela (postMessage
    // e reopenConversation recusam o cadastro anonimizado).
    anonymize(memory, aluno, pseudonimo) {
        const email = normalizeEmail(pseudonimo && pseudonimo.email);
        const mine = conversationList(memory).filter(ownedBy(aluno));
        if (!mine.length) return;
        const scrub = scrubberFor(aluno);
        const ids = idsOf(mine);
        const at = Date.now();
        mine.forEach(conv => {
            const read = readConversation(conv);
            conv.aluno = { ...conv.aluno, email: email || read.aluno.email, studentId: null };
            conv.assunto = read.iniciadaPor === 'aluno' ? '' : scrub(read.assunto);
            if (typeof conv.motivoEncerramento === 'string' && conv.motivoEncerramento) conv.motivoEncerramento = scrub(conv.motivoEncerramento);
            if (conv.status === 'aberta') {
                conv.status = 'encerrada';
                conv.encerradaEm = at;
                conv.encerradaPor = 'sistema';
                conv.motivoEncerramento = ANONYMIZED_CLOSE_REASON;
            }
        });
        memory.conversationMessages = messageList(memory).map(msg => {
            if (!ids.has(String(msg.conversationId || ''))) return msg;
            if (msg.autor === 'aluno') return { ...msg, autorEmail: email || msg.autorEmail, texto: ANONYMIZED_MESSAGE, anonimizada: true };
            const texto = scrub(msg.texto);
            return texto === msg.texto ? msg : { ...msg, texto };
        });
        scrubConversationAudit(memory, ids, scrub);
    },
    // Apagar de vez: as conversas do aluno e as mensagens delas saem.
    purge(memory, aluno) {
        const mine = conversationList(memory).filter(ownedBy(aluno));
        if (!mine.length) return;
        const ids = idsOf(mine);
        memory.conversations = list(memory.conversations).filter(conv => !(isObject(conv) && ids.has(String(conv.id))));
        memory.conversationMessages = list(memory.conversationMessages).filter(msg => !(isObject(msg) && ids.has(String(msg.conversationId || ''))));
        scrubConversationAudit(memory, ids, null);
    },
    // Mesclar: as conversas do 'sai' passam para o 'fica'. Os dois com conversa aberta com
    // o mesmo professor na mesma turma: a do 'sai' fica encerrada (com mergedFrom), para
    // continuar valendo "uma aberta por par".
    merge(memory, fica, sai) {
        const target = normalizeEmail(fica && fica.email);
        if (!target) return;
        const isFica = ownedBy(fica);
        const isSai = ownedBy(sai);
        const moved = new Set();
        const at = Date.now();
        mergeOwnedRecords(conversationList(memory), {
            isFica,
            isSai,
            keyOf: conv => {
                const read = readConversation(conv);
                return read.status === 'aberta' ? `${read.courseId}\n${read.studentClass}\n${read.instrutor.email}` : null;
            },
            reassign: conv => {
                moved.add(String(conv.id));
                conv.aluno = { ...conv.aluno, email: target, studentId: (fica && fica.id) || null };
            },
            archive: (conv, when) => {
                conv.status = 'encerrada';
                conv.encerradaEm = conv.encerradaEm || when;
                conv.encerradaPor = 'sistema';
                conv.motivoEncerramento = 'Cadastros mesclados';
            },
            origin: { studentEmail: sai && sai.email, studentId: sai && sai.id },
            at,
        });
        messageList(memory).forEach(msg => {
            if (msg.autor === 'aluno' && moved.has(String(msg.conversationId || ''))) msg.autorEmail = target;
        });
    },
    relink(memory, idsPorEmail) {
        return relinkRecordsByEmail(memory, conversationList(memory).map(conv => conv.aluno).filter(isObject), idsPorEmail, { emailField: 'email', idField: 'studentId' });
    },
    count(memory, aluno) {
        return conversationList(memory).filter(ownedBy(aluno)).length;
    },
    // Meus dados: as conversas do aluno com todas as mensagens, uma linha por mensagem. O
    // professor aparece pelo nome; o e-mail dele só na versão do administrador.
    exportSection(memory, aluno, audience) {
        const rows = exportRows(memory, aluno, audience);
        return rows.length ? rows : undefined;
    },
    printColumns: [
        { field: 'conversa', label: 'Conversa', format: 'text' },
        { field: 'turma', label: 'Turma', format: 'text' },
        { field: 'professor', label: 'Professor', format: 'text' },
        { field: 'autor', label: 'Quem escreveu', format: 'text' },
        { field: 'mensagem', label: 'Mensagem', format: 'text' },
        { field: 'enviadaEm', label: 'Enviada em', format: 'datetime' },
    ],
});

module.exports = {
    SCHEMA_VERSION,
    STATUSES,
    AUTHORS,
    LIMITS,
    MESSAGE_PERMISSION,
    READ_ALL_PERMISSION,
    RECEIVE_PREFERENCE,
    READ_NOTICE,
    KEEP_NOTICE,
    EXAM_IN_PROGRESS,
    ANONYMIZED_MESSAGE,
    ANONYMIZED_CLOSE_REASON,
    STUDENT_INACTIVE,
    CONVERSATION_ID_PATTERN,
    FEED_ID,
    cleanMessageText,
    readConversation,
    readMessage,
    findConversation,
    conversationClass,
    isStudentOf,
    isInstructorOf,
    messagesOf,
    unreadCounts,
    hasUnread,
    instructorAccount,
    receivesMessages,
    instructorServesClass,
    classRecipients,
    findRecipient,
    studentCanTalkInClass,
    isActiveStudentRecord,
    conversationStudent,
    conversationStudentActive,
    startConversation,
    postMessage,
    markRead,
    setArchivedByStudent,
    closeConversation,
    reopenConversation,
    studentConversations,
    studentConversationView,
    studentConversationSummary,
    studentMessagesView,
    openConversationFor,
    adminConversations,
    adminConversationView,
    adminMessagesView,
    messageView,
    notificationItems,
    queueItems,
};
