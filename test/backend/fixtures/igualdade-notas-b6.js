// Gerador da saída de hoje das notas SEM critérios de avaliação, para o teste de
// igualdade do B6 (P2-S3, D1 do P2: curso sem course.avaliacao continua com exatamente a
// conta de antes no boletim, no quadro, no CSV, no XLSX, na ficha, no Dashboard e no
// portal do aluno).
//
// Uso: node test/backend/fixtures/igualdade-notas-b6.js <raiz do repositório>
// Monta sempre a mesma memória, chama as rotas e escreve o resultado em JSON na saída.
// Usa só rotas que já existiam antes do B6, para rodar também numa cópia do código de
// antes: igualdade-notas-b6.json é a saída do código de antes (d9ca33f), e
// test/backend/notas-sem-criterios-igual.test.js confere que o código de agora dá a
// mesma coisa (os campos novos do B6 saem da comparação e são conferidos à parte).
//
// As datas dos registros são de 2025 e 2026 (longe da janela de "últimos 30 dias" da
// ficha), para a saída não depender do dia em que o teste roda; generatedAt vira '<agora>'.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
console.info = console.log;
console.warn = console.log;

const root = path.resolve(process.argv[2] || path.join(__dirname, '../../..'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-igualdade-notas-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const request = require(path.join(root, 'node_modules/supertest'));
const db = require(path.join(root, 'backend/database.js'));
const { createApp } = require(path.join(root, 'backend/server.js'));
const { createAdminSession, createStudentSession } = require(path.join(root, 'backend/utils/authSessions.js'));
const { parseTabularFile } = require(path.join(root, 'backend/utils/tabularFile.js'));

const ADMIN = 'adm@notas-b6.local';
const PROF = 'prof@notas-b6.local';
const MONITOR = 'monitor@notas-b6.local';
const ANA = 'ana@notas-b6.local';
const BIA = 'bia@notas-b6.local';
const CAIO = 'caio@notas-b6.local';
const DUDA = 'duda@notas-b6.local';

const GRADE = {
    1: [{ ordem: 1, inicio: '08:00', disciplinaId: 'PROG' }, { ordem: 2, inicio: '08:50', disciplinaId: 'PROG' }],
    3: [{ ordem: 1, inicio: '08:00', disciplinaId: 'BD' }],
};

function sub(id, email, name, examKey, score, extra = {}) {
    const { courseId = 'DES', studentClass = '1DES', ...rest } = extra;
    return {
        id,
        student: { name, email, studentClass, courseId },
        examKey,
        applicationId: null,
        score,
        correctCount: null,
        totalCount: null,
        gradedAnswers: [],
        type: rest.applicationId ? 'online' : 'impressa',
        attemptNumber: 1,
        resultStatus: 'considered',
        aggregationPolicy: 'highest',
        selectedForResult: false,
        gradePublished: true,
        timestamp: '2026-03-02T12:00:00.000Z',
        ...rest,
    };
}

function seedMemory() {
    const password = 'scrypt$fixo$fixo';
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password },
        { email: PROF, name: 'Professora Paula', role: 'professor', password, assignedClasses: [{ courseId: 'DES', className: '1DES' }] },
        { email: MONITOR, name: 'Monitor Mário', role: 'monitor', password, assignedClasses: [{ courseId: 'DES', className: '1DES' }] },
    ];
    db.memory.schools = [{ id: 'escola_a', name: 'Escola Alfa', info: {}, branding: {} }];
    db.memory.academicTerms = [{
        id: 'per_1_aaaaaa', schemaVersion: 1, nome: '2026 · 1º semestre', inicio: '2026-02-02', fim: '2026-06-26', schoolId: null,
        etapas: [{ ordem: 1, nome: '1º bimestre', inicio: '2026-02-02', fim: '2026-04-10' }, { ordem: 2, nome: '2º bimestre', inicio: '2026-04-13', fim: '2026-06-26' }],
        situacao: 'aberto', criadoEm: 1, criadoPor: ADMIN, atualizadoEm: 1,
    }];
    db.memory.nonSchoolDays = [];
    db.memory.courses = [
        {
            id: 'DES', name: 'Desenvolvimento', schoolId: 'escola_a',
            disciplinas: [
                { id: 'PROG', nome: 'Programação', cor: '', cargaHoraria: 80, professor: 'Prof. Paula', modulos: ['m1'] },
                { id: 'BD', nome: 'Banco de Dados', cor: '', modulos: ['m2'] },
            ],
            structure: [
                { id: 'm1', name: 'Lógica', units: [
                    { key: 'u1', name: 'Prova 1', apostilaKey: 'Ap_1', avaliacaoKey: 'Avaliacao_P1' },
                    { key: 'u2', name: 'Prova 2', apostilaKey: 'Ap_2', avaliacaoKey: 'Avaliacao_P2' },
                ] },
                { id: 'm2', name: 'Banco', units: [{ key: 'u3', name: 'Prova 3', apostilaKey: 'Ap_3', avaliacaoKey: 'Avaliacao_P3' }] },
            ],
        },
        { id: 'RED', name: 'Redes', schoolId: 'escola_a', structure: [{ id: 'r1', name: 'Redes', units: [{ key: 'r1', name: 'Prova R', avaliacaoKey: 'Avaliacao_R1' }] }] },
    ];
    db.memory.classes = [
        { name: '1DES', courseId: 'DES', period: 'Manhã', periodoLetivoId: 'per_1_aaaaaa', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
        { name: '2RED', courseId: 'RED', period: 'Noite' },
    ];
    db.memory.evaluations = {
        Avaliacao_P1: { title: 'Prova 1 — Lógica', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [] }] },
        Avaliacao_P2: { title: 'Prova 2', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [] }] },
        Avaliacao_P3: { title: 'Prova 3', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [] }] },
    };
    db.memory.students = [
        { name: 'Ana Souza', email: ANA, status: 'Ativo', password, matricula: '2026-001', classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES' },
        { name: 'Bia Lima', email: BIA, status: 'Ativo', password, matricula: '2026-002', classes: [{ name: '1DES', courseId: 'DES' }, { name: '2RED', courseId: 'RED' }] },
        { name: '=Caio', email: CAIO, status: 'Ativo', password, matricula: '2026-003', classes: [{ name: '1DES', courseId: 'DES' }] },
        { name: 'Duda Reis', email: DUDA, status: 'Ativo', password, matricula: '2026-004', classes: [{ name: '1DES', courseId: 'DES' }] },
    ];
    db.memory.examApplications = [
        { id: 'app_1', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: 'DES', status: 'finished', createdAt: '2026-03-01T10:00:00.000Z', startedAt: '2026-03-01T10:05:00.000Z' },
        { id: 'app_2', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: 'DES', status: 'finished', createdAt: '2026-03-15T10:00:00.000Z', startedAt: '2026-03-15T10:05:00.000Z' },
    ];
    db.memory.submissions = [
        // Ana: a P1 em duas aplicações (regra "média" na segunda), a P2 publicada, a P3 não publicada.
        sub('ana_p1_a', ANA, 'Ana Souza', 'Avaliacao_P1', 55, { applicationId: 'app_1' }),
        sub('ana_p1_b1', ANA, 'Ana Souza', 'Avaliacao_P1', 70, { applicationId: 'app_2', aggregationPolicy: 'average' }),
        sub('ana_p1_b2', ANA, 'Ana Souza', 'Avaliacao_P1', 91, { applicationId: 'app_2', aggregationPolicy: 'average', attemptNumber: 2, timestamp: '2026-03-15T12:00:00.000Z' }),
        sub('ana_p2', ANA, 'Ana Souza', 'Avaliacao_P2', 87),
        sub('ana_p3', ANA, 'Ana Souza', 'Avaliacao_P3', 64, { gradePublished: false }),
        // Bia: registro antigo sem curso (fica no curso da matrícula), nota inválida e a de Redes.
        sub('bia_p1', BIA, 'Bia Lima', 'Avaliacao_P1', 40, { courseId: undefined }),
        sub('bia_p2', BIA, 'Bia Lima', 'Avaliacao_P2', 150),
        sub('bia_r1', BIA, 'Bia Lima', 'Avaliacao_R1', 95, { courseId: 'RED', studentClass: '2RED' }),
        // Caio: nome com fórmula, duas tentativas na P3 com "escolhida".
        sub('caio_p3_a', CAIO, '=Caio', 'Avaliacao_P3', 59.5, { aggregationPolicy: 'selected' }),
        sub('caio_p3_b', CAIO, '=Caio', 'Avaliacao_P3', 72, { aggregationPolicy: 'selected', selectedForResult: true, attemptNumber: 2 }),
        // Prova que não está na estrutura.
        sub('caio_extra', CAIO, '=Caio', 'Avaliacao_Extra', 80),
    ];
    const chamada = (email, date, disciplinaId, statuses, extra = {}) => ({
        id: `att_${email.split('@')[0]}_${date}`,
        studentEmail: email, courseId: 'DES', studentClass: '1DES', date, origin: 'chamada', timestamp: Date.parse(`${date}T12:00:00.000Z`),
        aulas: statuses.map((status, index) => ({ ordem: index + 1, disciplinaId, status })),
        ...extra,
    });
    db.memory.attendance = [
        chamada(ANA, '2026-03-02', 'PROG', ['presente', 'presente']),
        chamada(ANA, '2026-03-04', 'BD', ['falta']),
        chamada(BIA, '2026-03-02', 'PROG', ['falta', 'falta']),
        chamada(BIA, '2026-03-04', 'BD', ['presente']),
        chamada(CAIO, '2026-03-02', 'PROG', ['presente', 'atraso']),
        chamada(CAIO, '2026-01-20', 'PROG', ['falta', 'falta']),
    ];
    db.memory.progress = { [ANA]: { Ap_1: true, Ap_2: [] } };
    db.memory.moduleAccess = [];
    db.memory.announcements = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
}

function stable(value, key) {
    if (['generatedAt'].includes(key)) return '<agora>';
    if (Array.isArray(value)) return value.map(item => stable(item));
    if (value && typeof value === 'object') {
        const out = {};
        Object.keys(value).forEach(name => { out[name] = stable(value[name], name); });
        return out;
    }
    return value;
}

function binary(res, callback) {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function main() {
    await db.init();
    seedMemory();
    const app = createApp();
    const admin = { 'x-admin-session': createAdminSession(db.memory, ADMIN) };
    const monitor = { 'x-admin-session': createAdminSession(db.memory, MONITOR) };
    const prof = { 'x-admin-session': createAdminSession(db.memory, PROF) };
    const out = {};
    const body = response => ({ status: response.status, body: response.body });
    const context = 'courseId=DES&studentClass=1DES';

    for (const email of [ANA, BIA, CAIO, DUDA]) {
        out[`boletim_${email.split('@')[0]}`] = body(await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(email)}&${context}`).set(admin));
    }
    out.boletimBiaSemCurso = body(await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(BIA)}`).set(admin));
    out.boletimBiaRedes = body(await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(BIA)}&courseId=RED`).set(admin));
    out.boletimMonitor = body(await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(ANA)}&${context}`).set(monitor));
    out.boletimProfessor = body(await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(ANA)}&${context}`).set(prof));
    out.boletimCursoErrado = body(await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(ANA)}&courseId=RED`).set(admin));

    out.quadro = body(await request(app).get(`/api/admin/gradebook?${context}`).set(admin));
    out.quadroProfessor = body(await request(app).get(`/api/admin/gradebook?${context}`).set(prof));
    const csv = await request(app).get(`/api/admin/gradebook?${context}&format=csv`).set(admin);
    out.quadroCsv = { status: csv.status, type: csv.headers['content-type'], text: csv.text };
    const xlsx = await request(app).get(`/api/admin/gradebook?${context}&format=xlsx`).set(admin).buffer(true).parse(binary);
    const parsed = parseTabularFile(xlsx.body, { nomeArquivo: 'quadro.xlsx' });
    out.quadroXlsx = { status: xlsx.status, linhas: parsed.linhas || parsed.rows || parsed };

    for (const email of [ANA, BIA]) {
        out[`ficha_${email.split('@')[0]}`] = body(await request(app).get(`/api/admin/student/dashboard?email=${encodeURIComponent(email)}&${context}`).set(admin));
    }
    out.visaoGeral = body(await request(app).get(`/api/admin/dashboard/students-overview?${context}`).set(admin));
    out.visaoGeralSemFiltro = body(await request(app).get('/api/admin/dashboard/students-overview').set(admin));

    for (const email of [ANA, BIA]) {
        const token = createStudentSession(db.memory, email);
        out[`portal_${email.split('@')[0]}`] = body(await request(app).get(`/api/student/dashboard?${context}`).set({ 'x-session-token': token }));
    }

    await new Promise(resolve => setTimeout(resolve, 200));
    process.stdout.write(`${JSON.stringify(stable(out), null, 1)}\n`);
}

main().then(() => {
    try { db.close && db.close(); } catch (error) { /* fim */ }
    setTimeout(() => process.exit(0), 50);
}).catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exit(1);
});
