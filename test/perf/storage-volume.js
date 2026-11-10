#!/usr/bin/env node
// Desempenho do banco com um ano de dados (fase 2, H1-c: DES-01, DES-11). Fora do
// test:backend e do test:quick: gera um banco sintético grande numa pasta temporária e
// mede o boot, a primeira gravação depois do boot, a gravação parcial de uma rota quente
// (studentExamState, o rascunho da prova) e a gravação completa.
//
// Uso: npm run test:perf [-- --scale 0.5] [-- --dir <pasta>] [-- --keep]
// - --scale: tamanho em relação a "um ano de 10 turmas" (padrão 1: 440 alunos, 6.111
//   entregas, 72 mil presenças, 18 mil logs de foco, 8 mil auditorias, 150 mil teclas;
//   cerca de 200 MB). 0.1 serve para conferir o script em segundos.
// - --dir: pasta dos dados (padrão: uma pasta nova em os.tmpdir(), apagada no fim).
// - --keep: não apaga a pasta no fim (para subir o servidor com ICLASS_DATA_DIR nela).
//
// Falha (código 1) se:
// - a primeira gravação depois do boot escrever alguma linha (regravar o banco inteiro
//   no boot deixava a fila parada por 26 s com um ano de dados);
// - o p95 do maior bloqueio do event loop numa gravação parcial de studentExamState
//   passar de 50 ms (cada rascunho da prova travando o servidor para a sala toda);
// - o boot sem migração passar de 10 s (escalado pelo --scale acima de 1).
//
// O build e a medição rodam em processos separados: a medição abre o banco do disco,
// como o servidor depois de ligar o computador.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const PARTIAL_SAVE_P95_LIMIT_MS = 50;
const BOOT_LIMIT_MS = 10000;
const PARTIAL_SAVES = 40;

function argValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const scale = Math.max(0.01, Number(argValue('--scale', '1')) || 1);
const phase = argValue('--phase', 'main');
const keep = process.argv.includes('--keep');

function count(base) {
    return Math.max(1, Math.round(base * scale));
}

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function megabytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadDatabase(dataDir) {
    process.env.ICLASS_DATA_DIR = dataDir;
    process.env.ICLASS_CONTENT_DIR = path.join(dataDir, 'content');
    process.env.ICLASS_ARCHIVE_DIR = path.join(dataDir, 'archives');
    process.env.TEST_MODE = '1';
    delete process.env.ICLASS_VERIFY_SAVES;
    delete process.env.NODE_TEST_CONTEXT;
    return require('../../backend/database.js');
}

function question(index) {
    return {
        originalNumber: index,
        text: `Questão ${index}: enunciado com alguma extensão, como numa prova real de múltipla escolha sobre o conteúdo da unidade.`,
        weight: 1,
        correctAnswer: 'A',
        alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: `Alternativa ${letter} de tamanho médio para a questão ${index}.`, isCorrect: letter === 'A' })),
    };
}

// Um ano de 10 turmas (escalado): os números vêm do banco medido no desenho do H1.
function populate(memory) {
    const courseId = 'curso_perf';
    const classCount = 10;
    const studentCount = count(440);
    memory.courses = [{ id: courseId, name: 'Curso de desempenho', structure: [] }];
    memory.classes = Array.from({ length: classCount }, (_, c) => ({ name: `T${c}`, courseId, period: 'Manhã', releasedItems: {}, examConfigs: {}, onlineExamConfigs: {} }));
    memory.students = Array.from({ length: studentCount }, (_, s) => ({
        name: `Aluno ${s}`, email: `aluno${s}@perf.local`, password: `scrypt$${'a'.repeat(22)}$${'b'.repeat(86)}`,
        classes: [{ name: `T${s % classCount}`, courseId, status: 'approved' }], studentClass: `T${s % classCount}`, status: 'Ativo', matricula: `2026-${s}`,
    }));
    const student = index => memory.students[index % studentCount];
    const snapshot = { title: 'Prova', questions: Array.from({ length: 20 }, (_, i) => question(i + 1)) };
    memory.submissions = Array.from({ length: count(6111) }, (_, i) => {
        const st = student(i);
        return {
            id: `sub_${i}`, student: { name: st.name, email: st.email, studentClass: st.studentClass, courseId, matricula: st.matricula, classes: st.classes, status: 'Ativo' },
            examKey: `Avaliacao_${1 + (i % 5)}`, applicationId: `app_${i % 150}`, attemptId: `att_${i}`, score: 7.5, correctCount: 15, totalCount: 20,
            gradedAnswers: Array.from({ length: 20 }, (_, q) => ({ questionNumber: q + 1, studentChoice: 'A', correctAnswer: 'A', isCorrect: true, weight: 1 })),
            assignedVersion: 'A', examSnapshot: snapshot, attemptNumber: 1, resultStatus: 'considered', gradePublished: true, timestamp: new Date().toISOString(),
        };
    });
    memory.attendance = Array.from({ length: count(72231) }, (_, i) => ({
        id: `pres_${i}`, studentEmail: student(i).email, studentClass: `T${i % classCount}`, courseId, date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
        status: 'presente', aulas: [1, 2, 3, 4], source: 'login', horaAcesso: '08:01', createdAt: Date.now(),
    }));
    memory.proctoringLogs = Array.from({ length: count(18000) }, (_, i) => ({
        id: `log_${i}`, studentEmail: student(i).email, studentClass: `T${i % classCount}`, courseId, examKey: 'Avaliacao_1', applicationId: `app_${i % 150}`,
        attemptId: `att_${i}`, timestamp: Date.now(), eventType: 'tab_blur', details: 'Saiu da aba da prova',
    }));
    memory.auditLogs = Array.from({ length: count(8000) }, (_, i) => ({
        id: `audit_${i}`, action: 'grade_changed', category: 'grades', actor: 'admin@perf.local', actorRole: 'admin', timestamp: Date.now(),
        target: { studentEmail: student(i).email }, before: { score: 5 }, after: { score: 7 }, details: { reason: 'revisão' },
    }));
    memory.loginLogs = Array.from({ length: count(5000) }, (_, i) => ({
        id: `login_${i}`, email: student(i).email, ip: '192.168.0.10', success: true, timestamp: Date.now(),
        userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    }));
    memory.moduleAccess = Array.from({ length: Math.min(10000, count(10000)) }, (_, i) => ({ id: `acc_${i}`, studentEmail: student(i).email, key: 'Apostila_1', moduleKey: 'Apostila_1', courseId, timestamp: Date.now() }));
    memory.examApplications = Array.from({ length: count(150) }, (_, i) => ({
        id: `app_${i}`, examKey: 'Avaliacao_1', studentClass: `T${i % classCount}`, courseId, status: 'finished',
        versionSnapshots: [{ version: 'A', questions: snapshot.questions }], studentVersions: {}, createdAt: new Date().toISOString(),
    }));
    // Uma sala em prova: 40 tentativas abertas.
    memory.studentExamState = {};
    for (let i = 0; i < 40; i++) {
        memory.studentExamState[`aluno${i}@perf.local_Avaliacao_2__app_aberta`] = {
            studentEmail: `aluno${i}@perf.local`, examKey: 'Avaliacao_2', applicationId: 'app_aberta', attemptId: `aberta_${i}`, startedAt: Date.now(),
            answers: { 1: 'A', 2: 'B' }, assignedQuestionNumbers: Array.from({ length: 20 }, (_, q) => q + 1),
        };
    }
}

async function buildPhase(dataDir) {
    const db = loadDatabase(dataDir);
    await db.init();
    populate(db.memory);
    let started = performance.now();
    await db.save();
    console.log(`  dados gravados em ${((performance.now() - started) / 1000).toFixed(1)} s`);
    // Teclas na tabela própria (H1-b), em lotes de 500 como o navegador manda.
    const keystrokes = count(150000);
    started = performance.now();
    const students = db.memory.students;
    for (let offset = 0; offset < keystrokes; offset += 500) {
        const batch = [];
        for (let i = offset; i < Math.min(keystrokes, offset + 500); i++) {
            const st = students[i % students.length];
            batch.push({
                studentEmail: st.email, studentClass: st.studentClass, courseId: 'curso_perf', examKey: 'Avaliacao_1', applicationId: `app_${i % 150}`,
                attemptId: `att_${i % 6000}`, seq: i, clientTs: Date.now(), key: 'a', code: 'KeyA', mods: '', kind: 'key', question: '3', blocked: false, suspicious: false,
            });
        }
        await db.keystrokes.append(batch);
    }
    console.log(`  ${keystrokes.toLocaleString('pt-BR')} teclas gravadas em ${((performance.now() - started) / 1000).toFixed(1)} s`);
    await db.close();
}

// Maior intervalo sem o event loop rodar durante fn() (sonda de 2 ms).
async function maxEventLoopBlock(fn) {
    let maxGap = 0;
    let last = performance.now();
    const probe = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last - 2);
        last = now;
    }, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    last = performance.now();
    maxGap = 0;
    const started = performance.now();
    const result = await fn();
    const total = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 5));
    clearInterval(probe);
    return { block: Math.max(0, maxGap), total, result };
}

async function measurePhase(dataDir) {
    const db = loadDatabase(dataDir);
    const bootStarted = performance.now();
    await db.init();
    const bootMs = performance.now() - bootStarted;
    const first = await db.save();
    const states = Object.values(db.memory.studentExamState);
    const blocks = [];
    const totals = [];
    for (let i = 0; i < PARTIAL_SAVES; i++) {
        const state = states[i % states.length];
        const measured = await maxEventLoopBlock(() => {
            state.answers = { ...state.answers, [3 + (i % 18)]: 'ABCD'[i % 4] };
            return db.save({ only: ['studentExamState'] });
        });
        blocks.push(measured.block);
        totals.push(measured.total);
    }
    const full = await maxEventLoopBlock(() => {
        states[0].answers = { ...states[0].answers, 20: 'D' };
        return db.save();
    });
    await db.refreshStorageStats();
    const status = db.storageStatus();
    await db.close();
    return {
        bootMs,
        firstSaveRows: Number(first && first.rows) || 0,
        partialBlockP95: percentile(blocks, 95),
        partialTotalP95: percentile(totals, 95),
        fullBlock: full.block,
        fullTotal: full.total,
        databaseBytes: status.databaseBytes,
        keystrokes: status.keystrokes,
        rss: process.memoryUsage().rss,
    };
}

function runPhase(name, dataDir) {
    const child = spawnSync(process.execPath, [__filename, '--phase', name, '--scale', String(scale), '--dir', dataDir], {
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    const output = child.stdout || '';
    output.split('\n').filter(line => line.startsWith('  ')).forEach(line => console.log(line));
    if (child.status !== 0) throw new Error(`fase ${name} saiu com ${child.status}\n${output}`);
    const match = output.match(/^RESULT=(.*)$/m);
    return match ? JSON.parse(match[1]) : null;
}

async function main() {
    if (phase === 'build' || phase === 'measure') {
        const dataDir = path.resolve(argValue('--dir', ''));
        if (phase === 'build') await buildPhase(dataDir);
        else console.log(`RESULT=${JSON.stringify(await measurePhase(dataDir))}`);
        return;
    }
    const givenDir = argValue('--dir', '');
    const dataDir = givenDir ? path.resolve(givenDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-perf-'));
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`Banco sintético (escala ${scale}) em ${dataDir}`);
    try {
        if (!fs.existsSync(path.join(dataDir, 'database.db'))) {
            const started = performance.now();
            runPhase('build', dataDir);
            console.log(`  banco gerado em ${((performance.now() - started) / 1000).toFixed(1)} s`);
        } else {
            console.log('  usando o banco que já estava na pasta');
        }
        const result = runPhase('measure', dataDir);
        console.log(`Arquivo: ${megabytes(result.databaseBytes)}, ${result.keystrokes.toLocaleString('pt-BR')} teclas, memória ${megabytes(result.rss)}`);
        console.log(`Boot (db.init): ${(result.bootMs / 1000).toFixed(2)} s`);
        console.log(`Primeira gravação depois do boot: ${result.firstSaveRows} linha(s)`);
        console.log(`Gravação parcial de studentExamState (${PARTIAL_SAVES}x): p95 do bloqueio ${result.partialBlockP95.toFixed(1)} ms, p95 do total ${result.partialTotalP95.toFixed(1)} ms`);
        console.log(`Gravação completa (uma alteração): bloqueio ${result.fullBlock.toFixed(1)} ms, total ${result.fullTotal.toFixed(1)} ms`);
        const bootLimit = BOOT_LIMIT_MS * Math.max(1, scale);
        const failures = [];
        if (result.firstSaveRows !== 0) failures.push(`a primeira gravação depois do boot escreveu ${result.firstSaveRows} linha(s) (esperado 0)`);
        if (result.partialBlockP95 > PARTIAL_SAVE_P95_LIMIT_MS) failures.push(`p95 do bloqueio na gravação parcial ${result.partialBlockP95.toFixed(1)} ms > ${PARTIAL_SAVE_P95_LIMIT_MS} ms`);
        if (result.bootMs > bootLimit) failures.push(`boot ${(result.bootMs / 1000).toFixed(2)} s > ${(bootLimit / 1000).toFixed(0)} s`);
        if (failures.length) {
            console.error(`\nFALHOU:\n- ${failures.join('\n- ')}`);
            process.exitCode = 1;
        } else {
            console.log('\nOK: dentro dos limites.');
        }
    } finally {
        if (!keep && !givenDir) fs.rmSync(dataDir, { recursive: true, force: true });
        else console.log(`Pasta mantida: ${dataDir}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
