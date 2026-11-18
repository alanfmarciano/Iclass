// Monitor numa passada só por coleção (fase 2, H2-D: DES-04).
//
// O monitor-status é consultado a cada 3 s enquanto o professor acompanha a prova. Antes,
// para CADA aluno da turma, ele percorria todas as entregas, todos os logs de foco e todos
// os estados de prova da escola (de todas as provas e anos), com toLowerCase em cada item:
// O(alunos × histórico), perto de 1 s por consulta com um ano de dados. Aqui cada coleção
// é lida uma vez e agrupada por e-mail; a rota só consulta os Maps.
//
// collectMonitorActivity(memory, { application, examKey, keystrokes }) devolve:
// - deliveriesByEmail: Map(e-mail -> entregas da prova/aplicação, da mais recente para a
//   mais antiga, pelo timestamp);
// - logsByEmail: Map(e-mail -> logs de foco da prova/aplicação, na ordem do armazenamento);
// - keystrokesByEmail: Map(e-mail -> { count, suspicious, lastAt }), dos contadores do
//   histórico de digitação (db.keystrokes.statsEntries, H1-b), sem ler as teclas;
// - attemptsByEmail: Map(e-mail -> [chave, estado][] da aplicação, por attemptNumber
//   decrescente). Só com aplicação (sem ela, fica vazio).
//
// As regras de casamento são as de antes, item por item:
// - prova comparada sem diferenciar maiúsculas (toLowerCase nas entregas e nos logs; as
//   teclas seguem a regra do store, igual ao SQLite);
// - com aplicação, só os itens dela (applicationId === application.id);
// - e-mail da entrega = studentEmail ou student.email, em minúsculas; o do log e o do
//   estado, studentEmail em minúsculas. O e-mail das teclas vem do store (sem espaços e em
//   minúsculas): a rota consulta com monitorKeystrokeEmail(email).
// Um item sem e-mail ou sem prova (gravado torto por uma versão antiga) não casa com
// ninguém, em vez de derrubar a consulta como antes.

function lowerText(value) {
    return value === undefined || value === null ? '' : String(value).toLowerCase();
}

function pushTo(map, key, value) {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

function timestampOf(item) {
    return new Date((item && item.timestamp) || 0).getTime();
}

// E-mail como o histórico de digitação grava (normalizedEmail do keystrokeStore).
function monitorKeystrokeEmail(email) {
    return lowerText(email).trim();
}

function collectMonitorActivity(memory, { application = null, examKey = '', keystrokes = null } = {}) {
    const source = memory || {};
    const wantedExam = lowerText(examKey);
    const applicationId = application ? application.id : null;
    const sameApplication = item => !application || item.applicationId === applicationId;

    const deliveriesByEmail = new Map();
    for (const submission of Array.isArray(source.submissions) ? source.submissions : []) {
        if (!submission || !submission.examKey || lowerText(submission.examKey) !== wantedExam || !sameApplication(submission)) continue;
        const email = lowerText(submission.studentEmail || (submission.student && submission.student.email) || '');
        pushTo(deliveriesByEmail, email, submission);
    }
    // Mesma ordem de antes: sort estável, da entrega mais recente para a mais antiga.
    deliveriesByEmail.forEach(list => list.sort((a, b) => timestampOf(b) - timestampOf(a)));

    const logsByEmail = new Map();
    for (const log of Array.isArray(source.proctoringLogs) ? source.proctoringLogs : []) {
        if (!log || lowerText(log.examKey) !== wantedExam || !log.studentEmail || !sameApplication(log)) continue;
        pushTo(logsByEmail, lowerText(log.studentEmail), log);
    }

    const attemptsByEmail = new Map();
    if (application) {
        const states = source.studentExamState && typeof source.studentExamState === 'object' ? source.studentExamState : {};
        for (const entry of Object.entries(states)) {
            const state = entry[1];
            if (!state || state.applicationId !== applicationId) continue;
            pushTo(attemptsByEmail, lowerText(state.studentEmail || ''), entry);
        }
        attemptsByEmail.forEach(list => list.sort((a, b) => Number(b[1].attemptNumber || 0) - Number(a[1].attemptNumber || 0)));
    }

    // Contadores do store: aluno e prova e, com aplicação, só os dela. Sem aplicação, soma
    // as aplicações do mesmo aluno e prova, como o Monitor sempre fez.
    const keystrokesByEmail = new Map();
    const entries = keystrokes && typeof keystrokes.statsEntries === 'function'
        ? keystrokes.statsEntries({ examKey, applicationId: applicationId || undefined })
        : [];
    for (const entry of entries) {
        if (!entry || !entry.total) continue;
        const email = monitorKeystrokeEmail(entry.studentEmail);
        let summary = keystrokesByEmail.get(email);
        if (!summary) {
            summary = { count: 0, suspicious: 0, lastAt: null };
            keystrokesByEmail.set(email, summary);
        }
        summary.count += Number(entry.total) || 0;
        summary.suspicious += Number(entry.suspicious) || 0;
        const at = entry.lastAt === null || entry.lastAt === undefined ? null : Number(entry.lastAt);
        if (at !== null && Number.isFinite(at) && (summary.lastAt === null || at > summary.lastAt)) summary.lastAt = at;
    }

    return { deliveriesByEmail, logsByEmail, keystrokesByEmail, attemptsByEmail };
}

module.exports = {
    collectMonitorActivity,
    monitorKeystrokeEmail,
};
