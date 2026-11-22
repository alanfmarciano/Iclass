// ---------------------------------------------------------------------------
// Pré-visualização como aluno: o que a sessão de leitura pode fazer (fase 3, P5-S6a,
// CRIT-08; contrato "previewAccess" do plano e C4 do P5).
//
// O instrutor abre uma prévia de uma turma (POST /api/admin/preview-sessions) e o portal
// manda o token no cabeçalho x-preview-session. Com ele, validateStudentSession e
// resolveRequester (middlewares.js) montam um aluno virtual da turma, que nunca entra em
// db.memory.students, e as rotas do portal respondem como responderiam a um aluno dela
// sem exceções individuais.
//
// Lista branca: com x-preview-session, só as rotas de PREVIEW_READ_ROUTES passam. Todas
// as outras (inclusive as que ainda vão nascer) respondem 403
// { code: 'preview_read_only', error: 'Na pré-visualização nada é gravado.' }: a lista
// negra esquece rota nova, a branca falha fechada. A recusa acontece duas vezes: no
// previewSessionGuard (server.js, antes de proctoringRoutes, porque log-activity grava) e
// de novo em validateStudentSession, para um router montado em outro lugar não escapar.
//
// Para uma rota entrar na lista, ela:
// - lê o aluno por req.studentAccount (nunca db.memory.students pelo req.studentEmail);
// - não grava nada quando req.preview é true (presença, touchSession, tentativa,
//   migração de registro antigo, leitura de aviso);
// - ganha uma linha no passeio de test/backend/student-preview.test.js, que percorre a
//   pilha do Express e falha com rota sem decisão.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { findPreviewSession, PREVIEW_TTL_MS } = require('./authSessions.js');
const { canAccessAdminPermission } = require('./adminPermissions.js');
const { activeGroupsForClass } = require('./classGroups.js');

const PREVIEW_HEADER = 'x-preview-session';
// Regra do guarda (rbac.regras_por_grupo do plano): qualquer uma basta para chegar na rota.
const PREVIEW_PERMISSIONS = Object.freeze(['page.materials', 'page.classes']);
// A prévia mostra o conteúdo das turmas (apostilas, biblioteca, provas abertas, fórum):
// abrir e usar pede também a permissão de conteúdo. Sem ela, o Professor auxiliar e a
// Secretaria, que têm page.classes, liam pela prévia as apostilas que o painel nega a
// eles (rbac.papeis: monitor "sem conteúdo"; secretaria "não mexe em conteúdo").
const PREVIEW_CONTENT_PERMISSION = 'page.materials';
const PREVIEW_STUDENT_NAME = 'Pré-visualização';
const PREVIEW_READ_ONLY = Object.freeze({ error: 'Na pré-visualização nada é gravado.', code: 'preview_read_only' });

// Rotas que a prévia lê. method + pattern sobre o caminho inteiro do pedido (sem a query),
// como o Express casa a rota: sem diferença de caixa e com a barra no fim opcional.
// - portal: as rotas do aluno que só leem (D20 do P5) e o download da biblioteca e das
//   imagens das apostilas (server.js sendControlledFile, que aceita o token da prévia em
//   ?access= ou no cabeçalho);
// - públicas: as que não pedem sessão e o portal chama com a prévia aberta (configuração,
//   conexão, documentos, identidade visual), que não leem nem gravam nada do aluno.
// Ficam de fora, com 403: envio e download de arquivo de tarefa, presença (/api/ping), Sair, prova (exam-state, autosave,
// log-*, validate-exam-token, start-attempt, submit, report-question), "Marcar como lidas",
// caderno e anotações (gravar), progresso (gravar), track-access, fórum (escrever),
// matrícula, troca de senha, aceite dos Termos, Meus dados (download auditado) e o
// histórico de mensagens da prova.
// O aviso de erro de tela (/api/client-error) passa: vira uma linha no registro de erros da pasta
// de dados e não toca no banco nem na memória; sem ele, o erro da tela vista na prévia
// sumia do registro. HEAD vale como GET (o Express responde HEAD pela rota GET).
const PREVIEW_READ_ROUTES = Object.freeze([
    { method: 'GET', pattern: /^\/(?:api\/)?data\.js$/i, label: 'data.js da turma (apostilas liberadas)' },
    { method: 'GET', pattern: /^\/[^/]+\.md$/i, label: 'apostila liberada (/:key.md)' },
    { method: 'GET', pattern: /^\/uploads\/[^/]+$/i, label: 'arquivo da biblioteca ou imagem de apostila' },
    { method: 'GET', pattern: /^\/imagens\/.+$/i, label: 'imagem das apostilas' },
    { method: 'GET', pattern: /^\/api\/status$/i, label: 'situação das provas e itens liberados' },
    { method: 'GET', pattern: /^\/api\/student\/sync$/i, label: 'sincronização (sem criar tentativa)' },
    { method: 'GET', pattern: /^\/api\/student\/exam-applications$/i, label: 'provas abertas da turma' },
    { method: 'GET', pattern: /^\/api\/student\/account$/i, label: 'Minha conta' },
    { method: 'GET', pattern: /^\/api\/student\/enrollments$/i, label: 'matrículas' },
    { method: 'GET', pattern: /^\/api\/student\/library$/i, label: 'biblioteca' },
    { method: 'GET', pattern: /^\/api\/student\/announcements$/i, label: 'avisos' },
    { method: 'GET', pattern: /^\/api\/student\/calendar-events$/i, label: 'calendário' },
    { method: 'GET', pattern: /^\/api\/student\/calendar\.ics$/i, label: 'agenda .ics da turma (B3)' },
    { method: 'GET', pattern: /^\/api\/student\/notifications$/i, label: 'sino' },
    { method: 'GET', pattern: /^\/api\/student\/dashboard$/i, label: 'Início' },
    { method: 'GET', pattern: /^\/api\/student\/assignments$/i, label: 'tarefas da turma' },
    { method: 'GET', pattern: /^\/api\/student\/assignments\/[^/]+$/i, label: 'tarefa (sem entrega: a prévia não envia nem baixa arquivo)' },
    { method: 'GET', pattern: /^\/api\/student\/progress$/i, label: 'progresso (ler)' },
    { method: 'GET', pattern: /^\/api\/student\/annotations$/i, label: 'anotações (ler)' },
    { method: 'GET', pattern: /^\/api\/student\/my-forum$/i, label: 'minhas dúvidas' },
    { method: 'GET', pattern: /^\/api\/forum$/i, label: 'dúvidas da unidade' },
    { method: 'GET', pattern: /^\/api\/student\/privacy\/status$/i, label: 'situação dos Termos (sem portão)' },
    { method: 'POST', pattern: /^\/api\/student\/notes\/get$/i, label: 'caderno (ler)' },
    { method: 'POST', pattern: /^\/api\/student\/my-submissions$/i, label: 'notas e entregas' },
    { method: 'GET', pattern: /^\/api\/settings\/public$/i, label: 'configuração pública' },
    { method: 'GET', pattern: /^\/api\/session\/status$/i, label: 'identidade do servidor' },
    { method: 'GET', pattern: /^\/api\/connection$/i, label: 'conexão' },
    { method: 'GET', pattern: /^\/api\/legal\/documents$/i, label: 'Termos e Política publicados' },
    { method: 'GET', pattern: /^\/api\/branding$/i, label: 'identidade visual' },
    { method: 'POST', pattern: /^\/api\/client-error$/i, label: 'aviso de erro de tela (só o registro de erros, nunca o banco)' },
].map(entry => Object.freeze(entry)));

// Caminho inteiro do pedido, sem a query e sem a barra do fim (como o Express casa).
function previewRequestPath(req) {
    const raw = String((req && (req.originalUrl || req.url)) || '/').split('?')[0];
    const trimmed = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    return trimmed || '/';
}

function isPreviewReadRoute(method, requestPath) {
    const upper = String(method || '').toUpperCase();
    const verb = upper === 'HEAD' ? 'GET' : upper;
    const pathName = String(requestPath || '');
    return PREVIEW_READ_ROUTES.some(entry => entry.method === verb && entry.pattern.test(pathName));
}

function isPreviewReadRequest(req) {
    return isPreviewReadRoute(req && req.method, previewRequestPath(req));
}

function previewToken(req) {
    const value = req && typeof req.get === 'function' ? req.get(PREVIEW_HEADER) : (req && req.headers ? req.headers[PREVIEW_HEADER] : '');
    return typeof value === 'string' ? value : '';
}

function hasPreviewHeader(req) {
    return previewToken(req) !== '';
}

function sendPreviewReadOnly(res) {
    return res.status(403).json({ ...PREVIEW_READ_ONLY });
}

// Fim da prévia (401 preview_ended). reason continua 'expired' (o motivo genérico de
// sessão terminada que o cliente já trata); previewReason diz a causa, com o texto dela:
// 'expired' (60 min), 'admin_session' (a sessão do painel que abriu a prévia acabou: Sair
// ou prazo absoluto), 'account' (senha trocada, nesta sessão ou em outro aparelho, ou
// conta apagada), 'permission' (perdeu a permissão ou a turma saiu do escopo), 'class'
// (turma ou curso apagados) e 'missing' (encerrada pelo painel, reinício do servidor,
// backup restaurado ou token desconhecido). A prévia de uma sessão do painel que saiu
// continua no mapa até o prazo dela (utils/authSessions.js) justamente para o motivo
// chegar ao portal; depois dos 60 min, vale 'expired'.
const PREVIEW_ENDED_MESSAGES = Object.freeze({
    expired: 'A pré-visualização terminou (ela dura 60 minutos). Abra de novo pelo painel.',
    admin_session: 'A pré-visualização terminou porque a sua sessão no painel acabou. Entre de novo e abra a pré-visualização.',
    account: 'A pré-visualização terminou porque a senha da sua conta mudou. Abra de novo pelo painel.',
    permission: 'A pré-visualização terminou porque a sua conta não tem mais acesso a esta turma.',
    class: 'A pré-visualização terminou porque a turma ou o curso não existem mais.',
    missing: 'A pré-visualização terminou. Abra de novo pelo painel.',
});

function previewEndedBody(previewReason) {
    const cause = Object.prototype.hasOwnProperty.call(PREVIEW_ENDED_MESSAGES, previewReason) ? previewReason : 'missing';
    return { error: PREVIEW_ENDED_MESSAGES[cause], sessionRevoked: true, reason: 'expired', code: 'preview_ended', previewReason: cause };
}

function sendPreviewEnded(res, previewReason) {
    return res.status(401).json(previewEndedBody(previewReason));
}

// Guarda global (server.js, depois do adminRbacGuard e antes de proctoringRoutes): com
// x-preview-session, só a lista branca passa. /api/admin segue a sessão do painel (o token
// da prévia não vale lá; o fim da prévia é /api/admin/preview-sessions/end).
function previewSessionGuard(req, res, next) {
    if (!hasPreviewHeader(req)) return next();
    const pathName = previewRequestPath(req);
    if (/^\/api\/admin(?:\/|$)/i.test(pathName)) return next();
    if (!isPreviewReadRoute(req.method, pathName)) return sendPreviewReadOnly(res);
    return next();
}

// Marca da senha da conta do instrutor quando a prévia abriu: senha trocada (por ele, pelo
// administrador ou pelo launcher) encerra a prévia. Só o sha256 do hash guardado.
function accountStamp(account) {
    return crypto.createHash('sha256').update(String((account && account.password) || ''), 'utf8').digest('hex').slice(0, 32);
}

function findClass(memory, courseId, studentClass) {
    return (Array.isArray(memory && memory.classes) ? memory.classes : [])
        .find(cls => cls && String(cls.courseId || '') === String(courseId || '') && String(cls.name || '') === String(studentClass || '')) || null;
}

function courseIsDeleted(course) {
    return !course || course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt;
}

// Grupo da turma que a prévia pode simular: só um grupo ativo (sem arquivadoEm) da mesma
// turma, lido por utils/classGroups.js (contrato "classGroups": grupos só por lá). Sem
// grupos na coleção (antes do P5-S4), nenhum grupo existe e o pedido com groupId dá 404.
function findPreviewGroup(memory, { courseId, studentClass, groupId }) {
    if (!groupId) return null;
    return activeGroupsForClass(memory, { courseId, studentClass }).find(group => String(group.id) === String(groupId)) || null;
}

// Aluno virtual (D19 do P5): o mesmo formato do cadastro que as rotas do portal leem,
// com matrícula aprovada só na turma da prévia, sem nenhum dado pessoal e com o e-mail
// .invalid, que nunca coincide com aluno real (nenhuma exceção individual vaza).
function buildPreviewStudent(session, cls) {
    const group = session.groupId ? { id: session.groupId } : null;
    return {
        id: null,
        email: session.studentEmail,
        name: PREVIEW_STUDENT_NAME,
        nomeSocial: '',
        status: 'Ativo',
        classes: [{ name: cls.name, courseId: cls.courseId, period: cls.period || '' }],
        studentClass: cls.name,
        courseId: cls.courseId,
        currentCourseId: cls.courseId,
        period: cls.period || '',
        enrollmentRequests: [],
        preview: true,
        previewGroupId: group ? group.id : null,
    };
}

// Rótulo da faixa: 'Pré-visualização como aluno de 1DES' (· grupo X).
function previewLabel(studentClass, group) {
    const base = `Pré-visualização como aluno de ${studentClass}`;
    const groupName = group && (group.nome || group.name);
    return groupName ? `${base} · grupo ${groupName}` : base;
}

// Confere a prévia deste token: { ok: true, session, student, cls, account } ou
// { ok: false, reason } com reason 'missing', 'expired', 'admin_session' (a sessão do
// instrutor acabou ou passou do prazo, com a mesma senha), 'account' (conta apagada ou
// senha trocada, mesmo quando a troca encerrou a sessão do painel),
// 'permission' (perdeu page.materials ou a turma saiu do escopo dele) ou 'class' (turma ou curso apagados).
// canAccessClass(account, className, courseId) vem de middlewares.js (adminCanAccessClass).
// Sem efeito colateral.
function resolvePreviewSession(memory, raw, { now = Date.now(), canAccessClass } = {}) {
    if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'missing' };
    const found = findPreviewSession(memory, raw, now);
    const { session } = found;
    const account = session ? (Array.isArray(memory.admins) ? memory.admins : [])
        .find(item => item && item.email && String(item.email).toLowerCase() === session.adminEmail) : null;
    const accountChanged = !account || accountStamp(account) !== (session && session.accountStamp);
    // Sessão do painel encerrada junto com a troca de senha (outro aparelho) ou com a conta
    // apagada: o motivo que o instrutor entende é a conta, não a sessão.
    if (found.reason === 'admin_session' && accountChanged) return { ok: false, reason: 'account' };
    if (found.reason) return { ok: false, reason: found.reason };
    if (accountChanged) return { ok: false, reason: 'account' };
    if (!canAccessAdminPermission(account, PREVIEW_PERMISSIONS) || !canAccessAdminPermission(account, PREVIEW_CONTENT_PERMISSION)) {
        return { ok: false, reason: 'permission' };
    }
    const cls = findClass(memory, session.courseId, session.studentClass);
    const course = (Array.isArray(memory.courses) ? memory.courses : []).find(item => item && String(item.id) === String(session.courseId));
    if (!cls || courseIsDeleted(course)) return { ok: false, reason: 'class' };
    if (typeof canAccessClass === 'function' && !canAccessClass(account, cls.name, cls.courseId)) return { ok: false, reason: 'permission' };
    return { ok: true, session, account, cls, student: buildPreviewStudent(session, cls) };
}

module.exports = {
    PREVIEW_CONTENT_PERMISSION,
    PREVIEW_ENDED_MESSAGES,
    PREVIEW_HEADER,
    PREVIEW_PERMISSIONS,
    PREVIEW_READ_ONLY,
    PREVIEW_READ_ROUTES,
    PREVIEW_STUDENT_NAME,
    PREVIEW_TTL_MS,
    accountStamp,
    buildPreviewStudent,
    findPreviewGroup,
    hasPreviewHeader,
    isPreviewReadRequest,
    isPreviewReadRoute,
    previewEndedBody,
    previewLabel,
    previewRequestPath,
    previewSessionGuard,
    previewToken,
    resolvePreviewSession,
    sendPreviewEnded,
    sendPreviewReadOnly,
};
