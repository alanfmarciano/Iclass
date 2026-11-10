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
//   "teste"): a regra inteira é ignorada, nem o login marca nem o servidor recusa, para
//   o aluno e para o instrutor (adminPasswordChangeState); só a senha temporária do
//   launcher continua pedindo a troca do instrutor, como antes;
// - durante uma prova em andamento (tentativa aberta numa aplicação ativa, dentro da janela
//   da tentativa (openAttemptWindowEnd), ou aplicação
//   ativa na turma do aluno, dentro da janela da prova, para quem ainda não abriu a
//   tentativa nela; ver studentHasExamInProgress): o login não
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
    '/api/student/logout',
    '/api/student/leave',
    '/api/client-error',
]);

// Rotas da prova (decisão do coordenador sobre o desvio do H5b, J2): depois do "Redefinir
// senha" com uma tentativa aberta, o token de antes do reset vale só para estas, até a
// tentativa fechar (entrega ou fim da janela): presença, estado e sincronização da prova,
// rascunho, registros de atividade e de teclas, entrega, mensagens do professor durante a
// prova, aviso de questão, token e início de tentativa (a tela da prova recarregada),
// saída e registro de erro da tela. Qualquer outra rota responde 401
// { reason: 'password_reset' } sem encerrar a sessão, para a prova continuar. Depois da
// entrega a sessão é revogada de vez (validateStudentSession).
const STUDENT_EXAM_SESSION_PATHS = new Set([
    '/api/ping',
    '/api/student/exam-state',
    '/api/student/sync',
    '/api/student/autosave-progress',
    '/api/student/log-activity',
    '/api/student/log-keystrokes',
    '/api/student/submit',
    '/api/student/acknowledge-message',
    '/api/student/message-history',
    '/api/student/message-history/delete',
    '/api/student/report-question',
    '/api/student/validate-exam-token',
    '/api/student/exam-applications',
    '/api/student/logout',
    '/api/student/leave',
    '/api/client-error',
]);

function isStudentExamSessionPath(routePath) {
    const value = String(routePath || '');
    if (STUDENT_EXAM_SESSION_PATHS.has(value)) return true;
    // POST /api/student/exam-applications/:applicationId/start-attempt
    return /^\/api\/student\/exam-applications\/[^/]+\/start-attempt$/.test(value);
}

function passwordChangeRuleActive() {
    return process.env.TEST_MODE !== '1';
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// O aluno está na turma da aplicação? Pelo nome da turma e, quando os dois lados têm,
// pelo curso (o mesmo nome de turma pode existir em dois cursos).
function studentInApplicationClass(student, application) {
    const className = String(application && application.studentClass || '').trim();
    if (!student || !className) return false;
    const courseId = String(application.courseId || '').trim();
    const memberships = Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student.studentClass ? [student.studentClass] : []);
    return memberships.some(item => {
        const name = String(typeof item === 'string' ? item : item && (item.name || item.className) || '').trim();
        if (name !== className) return false;
        const itemCourse = String(item && typeof item === 'object' ? item.courseId || '' : '').trim();
        return !courseId || !itemCourse || itemCourse === courseId;
    });
}

// Janela da prova na turma, para quem ainda não abriu a tentativa (studentHasExamInProgress).
// Começa no início mais recente conhecido da aplicação (startsAt da sala de espera ou do
// início, startedAt, preparedAt, createdAt) e dura o tempo da prova com o acréscimo geral
// e mais 30 min de folga, ou 4 h na prova sem cronômetro, somando o tempo em pausa. Sem
// isso, uma aplicação esquecida em andamento (prova sem cronômetro nunca vence) adiava a
// troca da turma inteira para sempre, e a senha temporária que o professor conhece
// continuava valendo.
const CLASS_EXAM_MARGIN_MS = 30 * 60 * 1000;
const CLASS_EXAM_UNTIMED_WINDOW_MS = 4 * 60 * 60 * 1000;

function timeValue(value) {
    if (value === null || value === undefined || value === '') return 0;
    const number = typeof value === 'number' ? value : (/^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)));
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function pausedMilliseconds(application, now) {
    const pauses = Array.isArray(application.pauses) ? application.pauses : [];
    return pauses.reduce((total, pause) => {
        const pausedAt = timeValue(pause && pause.pausedAt);
        if (!pausedAt) return total;
        const resumedAt = timeValue(pause.resumedAt) || now;
        return total + Math.max(0, resumedAt - pausedAt);
    }, 0);
}

// Fim da janela (ms) ou 0 quando a aplicação não traz hora nenhuma (aí só a tentativa
// aberta conta).
function classExamWindowEnd(application, now = Date.now()) {
    if (!application) return 0;
    const start = Math.max(
        timeValue(application.startsAt),
        timeValue(application.startedAt),
        timeValue(application.preparedAt),
        timeValue(application.createdAt),
    );
    if (!start) return 0;
    const minutes = Number(application.durationMinutes);
    const timed = application.timerEnabled !== false && Number.isFinite(minutes) && minutes > 0;
    const extra = Math.max(0, Number(application.globalTimeAdjustment) || 0);
    const length = timed ? (minutes + extra) * 60 * 1000 + CLASS_EXAM_MARGIN_MS : CLASS_EXAM_UNTIMED_WINDOW_MS;
    return start + length + pausedMilliseconds(application, now);
}

// Fim da janela de uma tentativa aberta (ms), ou 0 quando a tentativa não traz a hora de
// início (instruções, estado antigo: continua contando como aberta, como no H5a). Prova
// com cronômetro: o prazo da tentativa (início, duração, ajustes e pausas,
// computeAttemptDeadline) mais 30 min de folga. Sem cronômetro: 4 h desde o início da
// tentativa, somando o tempo em pausa. Sem isso, uma tentativa aberta numa aplicação
// esquecida em andamento (prova sem cronômetro nunca vence) contava como "em prova" para
// sempre: o "Redefinir senha" deixava a sessão de antes valendo até o prazo absoluto e a
// troca obrigatória ficava adiada.
function openAttemptWindowEnd(state, application, now = Date.now()) {
    const startedAt = timeValue(state && state.startedAt);
    if (!startedAt) return 0;
    // Carregado aqui: examDeadline.js puxa a correção das provas (sem dependência circular).
    const { computeAttemptDeadline } = require('./examDeadline.js');
    const deadline = Number(computeAttemptDeadline({ application, state, now }));
    if (Number.isFinite(deadline) && deadline > 0) return deadline + CLASS_EXAM_MARGIN_MS;
    return startedAt + CLASS_EXAM_UNTIMED_WINDOW_MS + pausedMilliseconds(application, now);
}

// Tentativas do aluno no estado das provas: { openAttempt, attemptedApplications }.
// openAttempt: alguma tentativa ainda não entregue numa aplicação aguardando, em
// andamento ou pausada, dentro da janela dela (openAttemptWindowEnd).
function scanStudentAttempts(memory, target, now = Date.now()) {
    const states = memory.studentExamState && typeof memory.studentExamState === 'object' ? memory.studentExamState : {};
    const attemptedApplications = new Set();
    let openAttempt = false;
    Object.keys(states).forEach(key => {
        const state = states[key];
        if (!state || typeof state !== 'object' || !state.applicationId) return;
        if (normalizeEmail(state.studentEmail) !== target) return;
        attemptedApplications.add(state.applicationId);
        if (openAttempt || CLOSED_ATTEMPT_STATUSES.has(state.status)) return;
        const application = findExamApplication(memory.examApplications, state.applicationId);
        if (!application || !ACTIVE_APPLICATION_STATUSES.has(application.status)) return;
        const windowEnd = openAttemptWindowEnd(state, application, now);
        if (!windowEnd || now <= windowEnd) openAttempt = true;
    });
    return { openAttempt, attemptedApplications };
}

// O aluno tem uma tentativa aberta agora (H5b, SEG-10)? Só a tentativa já aberta e ainda
// não entregue numa aplicação ativa, dentro da janela dela; a aplicação da turma que ele
// ainda não abriu não conta. É o que decide se o "Redefinir senha" deixa a sessão de antes
// terminar a prova: com a regra da turma (studentHasExamInProgress), quem tinha a senha
// antiga continuava entrando por até 4 h só porque a turma estava em prova.
function studentHasOpenAttempt(memory, email, now = Date.now()) {
    const target = normalizeEmail(email);
    if (!target || !memory) return false;
    return scanStudentAttempts(memory, target, now).openAttempt;
}

// O aluno está fazendo uma prova agora? Duas situações contam:
// - tentativa ainda não entregue numa aplicação aguardando, em andamento ou pausada;
// - aplicação aguardando, em andamento ou pausada na turma dele, antes de ele abrir a
//   tentativa: quem entra na aula da prova não perde o começo trocando a senha (na
//   primeira aula depois da atualização, as senhas fracas pedem a troca). Vale só para
//   quem ainda não tem tentativa nessa aplicação (quem já entregou não está mais em
//   prova) e só dentro da janela da prova (classExamWindowEnd).
// A troca fica para o login seguinte. Só roda quando a troca está pedida ou a senha do
// login é fraca, e percorre o estado das provas e as aplicações uma vez. student: o
// cadastro (sem ele, o primeiro aluno com o e-mail).
function studentHasExamInProgress(memory, email, student, now = Date.now()) {
    const target = normalizeEmail(email || (student && student.email));
    if (!target || !memory) return false;
    const { openAttempt, attemptedApplications } = scanStudentAttempts(memory, target, now);
    if (openAttempt) return true;
    const record = student || (Array.isArray(memory.students) ? memory.students.find(item => item && normalizeEmail(item.email) === target) : null);
    if (!record) return false;
    const applications = Array.isArray(memory.examApplications) ? memory.examApplications : [];
    return applications.some(application => application && ACTIVE_APPLICATION_STATUSES.has(application.status)
        && !attemptedApplications.has(application.id)
        && studentInApplicationClass(record, application)
        && now <= classExamWindowEnd(application, now));
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
    if (studentHasExamInProgress(memory, student.email, student)) {
        deferPasswordChange(session);
        return { required: false };
    }
    return { required: true, reason: passwordChangeReason(student) };
}

// A troca vale para a conta do instrutor agora? { required, reason }. Com TEST_MODE a
// regra do H5a (senha criada, redefinida ou fraca, com passwordChangeReason) é ignorada,
// como a do aluno (decisão P3). A senha temporária do launcher (scripts/
// reset-admin-password.js, sem passwordChangeReason) continua pedindo a troca mesmo
// assim, como antes do H5a: é a recuperação de acesso, não a regra nova.
function adminPasswordChangeState(account) {
    if (!account || account.mustChangePassword !== true) return { required: false };
    if (!passwordChangeRuleActive() && PASSWORD_CHANGE_REASONS.has(account.passwordChangeReason)) return { required: false };
    return { required: true, reason: passwordChangeReason(account) };
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
    STUDENT_EXAM_SESSION_PATHS,
    STUDENT_PASSWORD_CHANGE_PATHS,
    adminPasswordChangeState,
    classExamWindowEnd,
    deferPasswordChange,
    isPasswordChangeDeferred,
    isStudentExamSessionPath,
    passwordChangeReason,
    passwordChangeRequiredBody,
    passwordChangeRuleActive,
    passwordChanged,
    requirePasswordChange,
    studentHasExamInProgress,
    studentHasOpenAttempt,
    studentPasswordChangeState,
};
