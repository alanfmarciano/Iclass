// Processo filho de test/backend/database-boot.test.js e server-outage.test.js: cada
// execução é um boot (database.js abre o arquivo de ICLASS_DATA_DIR no require). Uso:
//   node server-boot-child.js <cenário> [argumento]
// Imprime '@@' seguido do resultado em JSON e termina fechando o banco. Os cenários de
// boot passam pelo prepareServer do server.js (o mesmo boot do servidor de verdade, sem
// o build e sem abrir a porta).
const fs = require('node:fs');
const path = require('node:path');

// O que o boot escreve no console (antes de carregar o servidor).
const logs = [];
['log', 'warn', 'error'].forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        logs.push(args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
        if (process.env.ICLASS_CHILD_ECHO) original(...args);
    };
});

const db = require('../../../backend/database.js');
const { prepareServer } = require('../../../backend/server.js');
const serverLifecycle = require('../../../backend/utils/serverLifecycle.js');
const {
    applicationToOnlineConfig,
    createAttemptState,
    createExamApplication,
    examStateKey,
} = require('../../../backend/utils/examApplications.js');
const { describeExamAudit } = require('../../../backend/utils/gradebook.js');

const uncaught = [];
process.on('uncaughtException', err => uncaught.push(String((err && err.message) || err)));
process.on('unhandledRejection', err => uncaught.push(String((err && err.message) || err)));

const MIN = 60000;
const COURSE_ID = 'c1';
const EXAM_KEY = 'Avaliacao_Boot';

function evaluation() {
    return {
        key: EXAM_KEY,
        title: 'Prova do boot',
        questions: ['A', 'B'].map((correct, index) => ({
            number: index + 1,
            originalNumber: index + 1,
            text: `Questão ${index + 1}`,
            correctAnswer: correct,
            alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}`, isCorrect: letter === correct })),
        })),
    };
}

// Turma com uma aplicação em andamento (cronômetro por tentativa) e a configuração dela
// como o servidor grava (applicationToOnlineConfig).
function runningApplication({ className, startsAt, durationMinutes = 30 }) {
    const application = createExamApplication({
        examKey: EXAM_KEY,
        courseId: COURSE_ID,
        studentClass: className,
        config: { durationMinutes, timerMode: 'per_attempt', questionCount: 2, shuffleQuestions: false, shuffleAnswers: false },
        status: 'running',
        now: startsAt,
        actor: 'teste',
    });
    db.memory.examApplications.push(application);
    const cls = {
        name: className,
        courseId: COURSE_ID,
        releasedItems: { [EXAM_KEY]: true },
        onlineExamConfigs: { [EXAM_KEY]: applicationToOnlineConfig(application, {}) },
        activeExamKey: EXAM_KEY,
        activeApplicationId: application.id,
        examHistory: {},
        // Campos que o boot completa nas turmas (populateDefaultsIfEmpty): a turma já
        // passou por um boot desta versão.
        examConfigs: {},
        registrationEnabled: true,
    };
    db.memory.classes.push(cls);
    return application;
}

function heartbeat() {
    try {
        return JSON.parse(fs.readFileSync(serverLifecycle.heartbeatFile(), 'utf8'));
    } catch (e) {
        return null;
    }
}

const scenarios = {
    // Primeiro boot (sem prepareServer): turma com prova em andamento, turma com prova de
    // versão antiga sem aplicação (já bloqueada), alunos e presenças. A turma antiga de
    // chave 'T1' foi gravada pelo teste antes deste boot.
    async seed() {
        await db.init();
        const now = Date.now();
        db.memory.courses = [{ id: COURSE_ID, name: 'Curso', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: EXAM_KEY }] }] }];
        db.memory.evaluations = { [EXAM_KEY]: evaluation() };
        runningApplication({ className: 'Turma Prova', startsAt: now - 5 * MIN });
        db.memory.classes.push({
            name: 'Turma Antiga',
            courseId: COURSE_ID,
            releasedItems: { [EXAM_KEY]: false },
            onlineExamConfigs: { [EXAM_KEY]: { onlineActive: false, status: 'not_applied', startTime: null, waitingRoomStartTimestamp: null } },
            examConfigs: {},
            registrationEnabled: true,
        });
        for (let index = 0; index < 30; index += 1) {
            db.memory.students.push({ name: `Aluno ${index}`, email: `aluno${index}@boot.local`, status: 'Ativo', classes: [{ name: 'Turma Prova', courseId: COURSE_ID }] });
            db.memory.attendance.push({ id: `presenca-${index}`, studentEmail: `aluno${index}@boot.local`, date: '2026-03-02', status: 'presente' });
        }
        await db.save();
        return { classes: db.memory.classes.map(cls => `${cls.courseId}::${cls.name}`) };
    },

    // Boot de verdade (prepareServer) e uma gravação completa logo depois.
    async boot() {
        await prepareServer();
        await db.save();
        serverLifecycle.stopHeartbeat();
        return { logs, students: db.memory.students.length, classes: db.memory.classes.length };
    },

    // Boot e uma entrega nova: só a entrega vai para o disco.
    async submission() {
        await prepareServer();
        await db.save();
        db.memory.submissions.push({ id: 'entrega-boot-1', student: { email: 'aluno1@boot.local' }, examKey: EXAM_KEY, timestamp: new Date().toISOString() });
        await db.save();
        serverLifecycle.stopHeartbeat();
        return { logs };
    },

    // Prova em andamento cujo prazo base venceu há overdueSec segundos; o servidor
    // "parou" há downSec segundos (heartbeat sem desligamento limpo). Sem prepareServer:
    // o heartbeat é escrito aqui, como a execução anterior teria deixado.
    async outageSeed(argument) {
        const [downSec, overdueSec, clean] = String(argument || '90,45,0').split(',').map(Number);
        await db.init();
        const now = Date.now();
        const durationMinutes = 30;
        db.memory.admins = [{ email: 'admin@boot.local', name: 'Admin', role: 'admin' }];
        db.memory.courses = [{ id: COURSE_ID, name: 'Curso', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: EXAM_KEY }] }] }];
        db.memory.evaluations = { [EXAM_KEY]: evaluation() };
        db.memory.students.push({ name: 'Ana', email: 'ana@boot.local', status: 'Ativo', classes: [{ name: 'Turma Prova', courseId: COURSE_ID }] });
        const application = runningApplication({ className: 'Turma Prova', startsAt: now - 40 * MIN, durationMinutes });
        const state = createAttemptState({ application, studentEmail: 'ana@boot.local', attemptNumber: 1, now: now - 32 * MIN });
        state.status = 'active';
        state.startedAt = now - durationMinutes * MIN - overdueSec * 1000;
        state.answers = { 1: 'A' };
        // Último salvamento um pouco antes da parada.
        state.savedAt = new Date(now - (downSec + 5) * 1000).toISOString();
        db.memory.studentExamState[examStateKey({ applicationId: application.id, studentEmail: 'ana@boot.local', attemptNumber: 1 })] = state;
        await db.save();
        fs.mkdirSync(path.dirname(serverLifecycle.heartbeatFile()), { recursive: true });
        fs.writeFileSync(serverLifecycle.heartbeatFile(), JSON.stringify({ at: now - downSec * 1000, clean: clean === 1, reason: clean === 1 ? 'stop' : null, instanceId: 'anterior', pid: 1 }));
        return { applicationId: application.id, attemptId: state.attemptId, baseDeadline: state.startedAt + durationMinutes * MIN, downSince: now - downSec * 1000 };
    },

    // Boot depois da parada: a varredura do fim do tempo roda no prepareServer.
    async outageBoot() {
        const bootAt = Date.now();
        await prepareServer();
        const application = db.memory.examApplications[0];
        const state = Object.values(db.memory.studentExamState)[0] || null;
        const audit = (db.memory.auditLogs || []).filter(entry => entry.type === 'exam_application_server_outage');
        const result = {
            bootAt,
            logs,
            previousRun: serverLifecycle.previousRun(),
            attempt: state ? { status: state.status, attemptId: state.attemptId } : null,
            submissions: db.memory.submissions.filter(item => item.applicationId === application.id).length,
            pauses: application.pauses || [],
            outages: application.outages || [],
            audit,
            auditView: audit.map(entry => describeExamAudit(entry)),
            heartbeat: heartbeat(),
        };
        // Desligamento limpo: o próximo boot sabe que foi parada pedida.
        serverLifecycle.markCleanShutdown('stop');
        result.heartbeatAfterStop = heartbeat();
        return result;
    },

    // Boot seguinte: a pausa e o registro da queda continuam gravados e não se repetem.
    async outageReboot() {
        await prepareServer();
        const application = db.memory.examApplications[0];
        serverLifecycle.stopHeartbeat();
        return {
            logs,
            previousRun: serverLifecycle.previousRun(),
            pauses: application.pauses || [],
            outages: application.outages || [],
        };
    },
};

(async () => {
    const [scenario, argument] = process.argv.slice(2);
    const result = await scenarios[scenario](argument);
    serverLifecycle.stopHeartbeat();
    await db.close();
    process.stdout.write(`@@${JSON.stringify({ ...result, uncaught })}`);
})().catch(err => {
    process.stdout.write(`@@${JSON.stringify({ fatal: String((err && err.stack) || err), logs, uncaught })}`);
    process.exitCode = 1;
});
