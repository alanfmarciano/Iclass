// Troca obrigatória de senha do aluno (H5a; UXA-13, SEG-06, decisão P3 do Alan).
//
// Quando vale: o aluno fica com mustChangePassword = true em dois casos:
// - a senha foi criada ou redefinida pelo professor (passwordChangeReason 'created' ou
//   'reset'). Na criação, a caixa "Pedir troca no primeiro acesso" vem marcada e pode
//   ser desmarcada; no "Redefinir senha" a troca é sempre pedida;
// - a senha digitada no login é fraca pela política de hoje (utils/passwordPolicy.js),
//   passwordChangeReason 'weak'.
// O autocadastro nunca pede a troca (o próprio aluno escolheu a senha, já pela política).
//
// Quando não vale:
// - TEST_MODE=1 (testes e o modo demonstração do launcher, com as contas demo de senha
//   "teste"): a regra inteira é ignorada, nem o login marca nem o servidor recusa;
// - durante uma prova em andamento (tentativa aberta numa aplicação ativa): o login não
//   marca a senha fraca (fica para o login seguinte) e, se a troca já estava pedida, a
//   sessão que estava em prova segue sem a troca até o fim (o pedido volta no próximo
//   login). A prova nunca recebe o 403.
//
// Com a troca pedida, validateStudentSession responde 403 { passwordChangeRequired:
// true } a tudo, menos às rotas de STUDENT_PASSWORD_CHANGE_PATHS (presença, a própria
// troca, a saída e o registro de erro da tela). A tela do portal mostra o formulário de
// troca no lugar da página.

const { ACTIVE_APPLICATION_STATUSES, CLOSED_ATTEMPT_STATUSES, findExamApplication } = require('./examApplications.js');

const PASSWORD_CHANGE_REASONS = new Set(['created', 'reset', 'weak']);

// Rotas que o aluno ainda usa com a troca pedida.
const STUDENT_PASSWORD_CHANGE_PATHS = new Set([
    '/api/ping',
    '/api/student/change-password',
    '/api/student/leave',
    '/api/client-error',
]);

function passwordChangeRuleActive() {
    return process.env.TEST_MODE !== '1';
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// O aluno está fazendo uma prova agora? Tentativa ainda não entregue numa aplicação
// aguardando, em andamento ou pausada. Só roda quando a troca está pedida (é raro), e
// percorre o estado das provas uma vez.
function studentHasExamInProgress(memory, email) {
    const target = normalizeEmail(email);
    if (!target || !memory) return false;
    const states = memory.studentExamState && typeof memory.studentExamState === 'object' ? memory.studentExamState : {};
    return Object.keys(states).some(key => {
        const state = states[key];
        if (!state || typeof state !== 'object' || CLOSED_ATTEMPT_STATUSES.has(state.status)) return false;
        if (normalizeEmail(state.studentEmail) !== target || !state.applicationId) return false;
        const application = findExamApplication(memory.examApplications, state.applicationId);
        return !!application && ACTIVE_APPLICATION_STATUSES.has(application.status);
    });
}

// Sessões que estavam em prova quando a troca foi pedida seguem sem ela até o fim (só
// na memória: depois de um reinício vale de novo a conferência da prova em andamento).
// WeakMap pelo objeto da sessão: a sessão encerrada some daqui sozinha.
const deferredSessions = new WeakMap();

function deferPasswordChange(session) {
    if (session && typeof session === 'object') deferredSessions.set(session, true);
}

function isPasswordChangeDeferred(session) {
    return !!(session && typeof session === 'object' && deferredSessions.get(session));
}

function passwordChangeReason(account) {
    const reason = account && account.passwordChangeReason;
    return PASSWORD_CHANGE_REASONS.has(reason) ? reason : 'reset';
}

// A troca vale para esta sessão agora? { required, reason }. Quem chama decide o que
// fazer com as rotas liberadas.
function studentPasswordChangeState(memory, student, session) {
    if (!passwordChangeRuleActive() || !student || student.mustChangePassword !== true) return { required: false };
    if (isPasswordChangeDeferred(session)) return { required: false };
    if (studentHasExamInProgress(memory, student.email)) {
        deferPasswordChange(session);
        return { required: false };
    }
    return { required: true, reason: passwordChangeReason(student) };
}

// Corpo do 403 (formato combinado entre os grupos: 403 { passwordChangeRequired: true }).
function passwordChangeRequiredBody(reason) {
    return { error: 'Troque a senha antes de continuar.', passwordChangeRequired: true, passwordChangeReason: reason };
}

// Pede a troca na conta (aluno ou instrutor).
function requirePasswordChange(account, reason) {
    if (!account || typeof account !== 'object') return;
    account.mustChangePassword = true;
    account.passwordChangeReason = PASSWORD_CHANGE_REASONS.has(reason) ? reason : 'reset';
}

// Senha nova gravada: a troca deixa de valer.
function passwordChanged(account, now = Date.now()) {
    if (!account || typeof account !== 'object') return;
    account.mustChangePassword = false;
    delete account.passwordChangeReason;
    account.passwordChangedAt = new Date(now).toISOString();
}

module.exports = {
    PASSWORD_CHANGE_REASONS,
    STUDENT_PASSWORD_CHANGE_PATHS,
    deferPasswordChange,
    isPasswordChangeDeferred,
    passwordChangeReason,
    passwordChangeRequiredBody,
    passwordChangeRuleActive,
    passwordChanged,
    requirePasswordChange,
    studentHasExamInProgress,
    studentPasswordChangeState,
};
