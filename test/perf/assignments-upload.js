#!/usr/bin/env node
// Envio de tarefa com a sala inteira ao mesmo tempo (fase 3, C5 / P1-c; FUN-01, conferência
// C-NUVEM-3 do P1 e da J1). Fora do test:backend: sobe o servidor numa pasta temporária,
// cria uma turma com N alunos e uma tarefa, e manda os envios ao mesmo tempo por HTTP de
// verdade (fetch + FormData do Node, sem pacote), como os celulares no fim do prazo. O
// servidor roda neste processo; os envios e a medição das outras rotas rodam em dois
// processos filhos (o mesmo arquivo com --fase envios e --fase medicao), para o tempo
// medido ser o do servidor e não o do laço de eventos de quem manda centenas de MB.
//
// Uso: node test/perf/assignments-upload.js [--alunos 40] [--mb 8] [--mesmo-aluno 5] [--keep]
// - --alunos: quantos alunos enviam ao mesmo tempo (padrão 40), um arquivo cada;
// - --mb: tamanho de cada arquivo em MB (padrão 8);
// - --mesmo-aluno: quantos envios simultâneos de um mesmo aluno a mais (padrão 5), que
//   precisam virar as versões 1..N sem repetir;
// - --keep: não apaga a pasta temporária no fim.
//
// Falha (código 1) se:
// - algum envio não responder 201;
// - faltar entrega, versão, arquivo em data/entregas (com o sha256 do registro) ou a
//   auditoria de algum envio no banco gravado, ou sobrar temporário em .recebendo;
// - as versões do mesmo aluno repetirem número ou pularem;
// - alguma versão ficar pela metade (versão sem arquivo, arquivo sem registro);
// - o tempo de resposta das outras rotas (lista de tarefas e configuração pública) durante
//   os envios passar de 2 s no pior caso (a sala continua usando o portal).
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { performance } = require('perf_hooks');

function argValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const STUDENTS = Math.max(1, Math.floor(Number(argValue('--alunos', '40')) || 40));
const FILE_MB = Math.max(0.01, Number(argValue('--mb', '8')) || 8);
const SAME_STUDENT = Math.max(0, Math.floor(Number(argValue('--mesmo-aluno', '5'))) || 0);
const KEEP = process.argv.includes('--keep');
const PHASE = argValue('--fase', 'servidor');
const OTHER_ROUTE_LIMIT_MS = 2000;
const COURSE = 'curso-perf';
const CLASS = 'Turma-Perf';

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// PDF de mentira com o tamanho pedido (assinatura certa, conteúdo diferente por aluno).
function fileFor(index) {
    const size = Math.max(64, Math.floor(FILE_MB * 1024 * 1024));
    const buffer = Buffer.alloc(size, 0x20);
    Buffer.from(`%PDF-1.4\n% aluno ${index}\n`).copy(buffer);
    crypto.randomBytes(16).copy(buffer, 32);
    Buffer.from('\n%%EOF\n').copy(buffer, size - 7);
    return buffer;
}

// ------------------------------------------------------------ processos filhos
// Os envios ao mesmo tempo. job = { base, assignmentId, tokens }.
async function clientsPhase(job) {
    const files = Array.from({ length: STUDENTS }, (_, index) => fileFor(index));
    const sameFiles = Array.from({ length: SAME_STUDENT }, (_, index) => fileFor(1000 + index));
    const send = async (token, buffer, name) => {
        const form = new FormData();
        form.append('files', new Blob([buffer], { type: 'application/pdf' }), name);
        form.append('text', 'Segue o trabalho.');
        const started = performance.now();
        const response = await fetch(`${job.base}/api/student/assignments/${job.assignmentId}/submit`, {
            method: 'POST', headers: { 'x-session-token': token }, body: form,
        });
        const body = await response.json().catch(() => ({}));
        return { status: response.status, body, ms: performance.now() - started };
    };
    const started = performance.now();
    const results = await Promise.all([
        ...files.map((buffer, index) => send(job.tokens[index], buffer, `Trabalho do aluno ${index + 1}.pdf`)),
        ...sameFiles.map((buffer, index) => send(job.tokens[0], buffer, `Versão extra ${index + 1}.pdf`)),
    ]);
    return { results, totalMs: performance.now() - started };
}

// As outras rotas enquanto os envios correm, até receber 'parar'.
// job = { base, courseId, studentClass, token }.
async function probePhase(job) {
    const latencies = [];
    let stop = false;
    process.on('message', message => { if (message === 'parar') stop = true; });
    while (!stop) {
        const started = performance.now();
        const list = await fetch(`${job.base}/api/student/assignments?courseId=${encodeURIComponent(job.courseId)}&studentClass=${encodeURIComponent(job.studentClass)}`, {
            headers: { 'x-session-token': job.token },
        });
        await list.arrayBuffer();
        const settings = await fetch(`${job.base}/api/settings/public`);
        await settings.arrayBuffer();
        latencies.push(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return latencies;
}

function runChild(phase, job, onStart) {
    return new Promise((resolve, reject) => {
        const child = fork(__filename, [...process.argv.slice(2), '--fase', phase], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.on('message', message => {
            if (message === 'pronto') {
                child.send(job);
                if (onStart) onStart(child);
            } else if (message && Object.prototype.hasOwnProperty.call(message, 'result')) {
                resolve(message.result);
            }
        });
        child.once('error', reject);
        child.once('exit', code => { if (code) reject(new Error(`o processo "${phase}" saiu com o código ${code}`)); });
    });
}

function childMain() {
    process.once('message', async job => {
        try {
            const result = PHASE === 'envios' ? await clientsPhase(job) : await probePhase(job);
            process.send({ result }, () => process.exit(0));
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    });
    process.send('pronto');
}

// ------------------------------------------------------------ servidor e conferência
async function serverMain() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-perf-entregas-'));
    process.env.ICLASS_DATA_DIR = dataDir;
    process.env.ICLASS_CONTENT_DIR = path.join(dataDir, 'content');
    process.env.ICLASS_ARCHIVE_DIR = path.join(dataDir, 'archives');
    process.env.TEST_MODE = '1';
    const db = require('../../backend/database.js');
    const runtimePaths = require('../../backend/runtimePaths.js');
    const assignments = require('../../backend/utils/assignments.js');
    const assignmentFiles = require('../../backend/utils/assignmentFiles.js');
    const { createStudentSession } = require('../../backend/utils/authSessions.js');
    const { createApp } = require('../../backend/server.js');

    await db.init();
    const now = Date.now();
    const perFile = Math.max(1, Math.ceil(FILE_MB));
    db.memory.config = {
        ...(db.memory.config || {}),
        settings: { ...((db.memory.config && db.memory.config.settings) || {}), entregas: { maxMbPorArquivo: Math.max(20, perFile), maxMbPorEnvio: Math.max(50, perFile * 2), discoLivreMinimoMb: 0 } },
    };
    db.memory.courses = [{ id: COURSE, name: 'Curso de desempenho', structure: [] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }];
    db.memory.students = Array.from({ length: STUDENTS }, (_, index) => ({
        id: `alu_${crypto.randomBytes(8).toString('hex')}`,
        name: `Aluno ${index + 1}`,
        email: `aluno${index + 1}@perf.local`,
        status: 'Ativo',
        classes: [{ name: CLASS, courseId: COURSE }],
    }));
    const task = assignments.newAssignmentRecord({
        courseId: COURSE, studentClass: CLASS, title: 'Trabalho final',
        response: { files: true, text: true, link: false },
        files: { maxFiles: 2, maxSizeMb: Math.max(10, perFile), types: ['pdf'], extraExtensions: [] },
        dueAt: now + 60 * 60 * 1000, status: 'publicada',
    }, { actor: 'prof@perf.local', now });
    db.memory.assignments = [task];
    db.memory.assignmentSubmissions = [];
    db.memory.auditLogs = [];
    const tokens = db.memory.students.map(student => createStudentSession(db.memory, student.email));
    await db.save();

    const app = createApp();
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    let probeChild = null;
    const probe = runChild('medicao', { base, courseId: COURSE, studentClass: CLASS, token: tokens[STUDENTS - 1] }, child => { probeChild = child; });
    const { results, totalMs } = await runChild('envios', { base, assignmentId: task.id, tokens });
    if (probeChild) probeChild.send('parar');
    const otherLatencies = await probe;
    await new Promise(resolve => server.close(resolve));

    const problems = [];
    results.forEach((result, index) => {
        if (result.status !== 201) problems.push(`envio ${index + 1}: ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
    });

    // O que ficou gravado no banco (não só a memória).
    const stored = (await db.readStoredData()).memory;
    const subs = stored.assignmentSubmissions || [];
    if (subs.length !== STUDENTS) problems.push(`esperadas ${STUDENTS} entregas, gravadas ${subs.length}`);
    const expectedVersions = STUDENTS + SAME_STUDENT;
    let versions = 0;
    let registeredFiles = 0;
    const registered = new Set();
    subs.forEach(raw => {
        const sub = assignments.normalizeSubmission(raw);
        versions += sub.versions.length;
        const numbers = sub.versions.map(version => version.n);
        const expected = Array.from({ length: numbers.length }, (_, index) => index + 1);
        if (JSON.stringify(numbers) !== JSON.stringify(expected)) problems.push(`${sub.studentEmail}: versões ${numbers.join(',')}`);
        sub.versions.forEach(version => {
            if (!version.files.length) problems.push(`${sub.studentEmail} v${version.n}: versão sem arquivo`);
            version.files.forEach(file => {
                registeredFiles += 1;
                registered.add(file.storedRel);
                let abs;
                try { abs = assignmentFiles.absFromStoredRel(file.storedRel); } catch (e) { problems.push(`caminho estranho ${file.storedRel}`); return; }
                if (!fs.existsSync(abs)) { problems.push(`arquivo ausente ${file.storedRel}`); return; }
                const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
                if (sha !== file.sha256) problems.push(`sha256 diferente em ${file.storedRel}`);
            });
        });
    });
    if (versions !== expectedVersions) problems.push(`esperadas ${expectedVersions} versões, gravadas ${versions}`);
    const audits = (stored.auditLogs || []).filter(entry => entry.action === 'assignment_submitted').length;
    if (audits !== expectedVersions) problems.push(`esperadas ${expectedVersions} auditorias, gravadas ${audits}`);
    const onDisk = [];
    const walk = dir => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(abs);
            else onDisk.push(path.relative(runtimePaths.DATA_DIR, abs).split(path.sep).join('/'));
        });
    };
    walk(runtimePaths.ASSIGNMENT_FILES_DIR);
    const leftovers = onDisk.filter(rel => rel.startsWith('entregas/.recebendo/'));
    if (leftovers.length) problems.push(`${leftovers.length} temporário(s) em .recebendo`);
    const orphans = onDisk.filter(rel => !rel.startsWith('entregas/.recebendo/') && !registered.has(rel));
    if (orphans.length) problems.push(`${orphans.length} arquivo(s) sem registro: ${orphans.slice(0, 3).join(', ')}`);
    const worstOther = Math.max(0, ...otherLatencies);
    if (worstOther > OTHER_ROUTE_LIMIT_MS) problems.push(`outra rota demorou ${worstOther.toFixed(0)} ms durante os envios (limite ${OTHER_ROUTE_LIMIT_MS} ms)`);

    const uploadTimes = results.map(result => result.ms);
    console.log(`Envios: ${results.length} (${STUDENTS} alunos + ${SAME_STUDENT} do mesmo aluno), ${FILE_MB} MB cada, ${(results.length * FILE_MB).toFixed(0)} MB no total`);
    console.log(`Tempo total: ${(totalMs / 1000).toFixed(1)} s; por envio p50 ${percentile(uploadTimes, 50).toFixed(0)} ms, p95 ${percentile(uploadTimes, 95).toFixed(0)} ms, máximo ${Math.max(...uploadTimes).toFixed(0)} ms`);
    console.log(`Outras rotas durante os envios (${otherLatencies.length} medições): p95 ${percentile(otherLatencies, 95).toFixed(0)} ms, pior ${worstOther.toFixed(0)} ms`);
    console.log(`Gravado: ${subs.length} entregas, ${versions} versões, ${registeredFiles} arquivos, ${audits} auditorias`);

    await db.close();
    if (!KEEP) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`Pasta mantida: ${dataDir}`);
    if (problems.length) {
        console.error(`FALHOU:\n- ${problems.join('\n- ')}`);
        process.exit(1);
    }
    console.log('OK: nenhum envio perdido nem versão pela metade.');
    process.exit(0);
}

if (PHASE === 'servidor') {
    serverMain().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    childMain();
}
