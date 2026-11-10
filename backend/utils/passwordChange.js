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
// - durante uma prova em andamento (tentativa aberta numa aplicação ativa, ou aplicação
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
        if (application && ACTIVE_APPLICATION_STATUSES.has(application.status)) openAttempt = true;
    });
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
    STUDENT_PASSWORD_CHANGE_PATHS,
    adminPasswordChangeState,
    classExamWindowEnd,
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
