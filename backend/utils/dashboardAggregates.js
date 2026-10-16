// Dashboard v3 — agregadores das faixas "Agora", "Precisa de você" e "Pulso".
// Funções puras: recebem memory + contexto resolvido (turma, curso, alunos já
// escopados pelo professor) e devolvem os payloads dos endpoints. Nada aqui lê
// req/res nem aplica permissão — isso é papel da rota (admin.js).
//
// Armadilha de datas (ver PLANO_DASHBOARD_V3.md §2.3): `submissions.timestamp` é
// string ISO, `attendance.date` é 'YYYY-MM-DD' e `moduleAccess.timestamp` é número
// em ms. Toda normalização acontece AQUI, na entrada — nunca no consumidor.

const attendanceUtil = require('./attendance.js');

const DIA_MS = 86400000;
const AULA_PADRAO_MIN = 50; // grade só tem o início; o fim é o início da próxima ou +50min
const ONLINE_JANELA_MIN = 5;
const ACTIVE_APP = new Set(['waiting', 'running', 'paused']);

function lower(v) { return String(v || '').trim().toLowerCase(); }
function emailSet(students) { return new Set(students.map(s => lower(s.email)).filter(Boolean)); }
function tsOf(value) { // aceita ISO, ms numérico ou Date — devolve ms ou null
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function addDays(ymd, days) {
    const d = new Date(`${ymd}T12:00:00Z`); // meio-dia evita rollover de fuso
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
function minToHHMM(min) {
    if (min == null) return '';
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function discNameMap(course) {
    const map = {};
    ((course && course.disciplinas) || []).forEach(d => { map[d.id] = d.nome; });
    return map;
}
function aulaNome(discMap, aula) {
    return discMap[aula.disciplinaId] || aula.disciplinaId || `Aula ${aula.ordem}`;
}
function evalTitle(memory, examKey) {
    const ev = (memory.evaluations || {})[examKey];
    return (ev && (ev.title || ev.titulo)) || examKey;
}

// Registros de chamada de hoje para a turma (origin 'chamada', alunos do escopo).
function chamadaHoje(memory, cls, emails, today) {
    return (memory.attendance || []).filter(r => r.date === today && r.origin === 'chamada'
        && (!cls || !r.studentClass || r.studentClass === cls.name)
        && emails.has(lower(r.studentEmail)));
}
function chamadaStatusHoje(memory, cls, emails, today) {
    const recs = chamadaHoje(memory, cls, emails, today);
    if (recs.some(r => r.concluida)) return 'concluida';
    return recs.length ? 'rascunho' : 'nao_lancada';
}

// Aplicações da turma (courseId é opcional em aplicações antigas).
function classApplications(memory, cls, course) {
    if (!cls) return [];
    return (memory.examApplications || []).filter(a => a.studentClass === cls.name
        && (!a.courseId || !course || String(a.courseId) === String(course.id)));
}

// ---------------------------------------------------------------------------
// AGORA — o que está acontecendo nesta turma neste minuto.
// ---------------------------------------------------------------------------
function computeNow({ memory, cls, course, students, today, nowMin, now }) {
    const cfg = attendanceUtil.effectiveAttendanceConfig(cls);
    const discMap = discNameMap(course);
    const emails = emailSet(students);
    const grade = cls ? attendanceUtil.gradeForDate(cls, today) : [];

    const bounds = grade.map((a, i) => {
        const ini = attendanceUtil.hhmmToMin(a.inicio);
        const next = grade[i + 1] ? attendanceUtil.hhmmToMin(grade[i + 1].inicio) : null;
        const fim = ini == null ? null : (next != null && next > ini ? next : ini + AULA_PADRAO_MIN);
        return { ...a, iniMin: ini, fimMin: fim };
    });
    const emCurso = bounds.find(a => a.iniMin != null && nowMin >= a.iniMin && nowMin < a.fimMin);
    const chamadaStatus = chamadaStatusHoje(memory, cls, emails, today);

    const aula = emCurso ? {
        ordem: emCurso.ordem,
        disciplinaId: emCurso.disciplinaId || '',
        nome: aulaNome(discMap, emCurso),
        inicio: emCurso.inicio || '',
        fim: minToHHMM(emCurso.fimMin),
        toleranciaMin: cfg.toleranciaMin,
        chamadaStatus,
    } : null;

    // Fora de horário: aponta a próxima aula (hoje mais tarde, ou nos próximos 7 dias).
    let proximaAula = null;
    if (!emCurso && cls) {
        const depois = bounds.find(a => a.iniMin != null && a.iniMin > nowMin);
        if (depois) {
            proximaAula = { data: today, inicio: depois.inicio || '', nome: aulaNome(discMap, depois) };
        } else {
            for (let d = 1; d <= 7 && !proximaAula; d++) {
                const ds = addDays(today, d);
                const g = attendanceUtil.gradeForDate(cls, ds);
                if (g.length) proximaAula = { data: ds, inicio: g[0].inicio || '', nome: aulaNome(discMap, g[0]) };
            }
        }
    }

    const apps = classApplications(memory, cls, course);
    const ativa = apps.find(a => ACTIVE_APP.has(a.status));
    let aplicacao = null;
    if (ativa) {
        const entregues = new Set((memory.submissions || [])
            .filter(s => s.examKey === ativa.examKey && s.student && emails.has(lower(s.student.email)))
            .map(s => lower(s.student.email))).size;
        aplicacao = {
            id: ativa.id, examKey: ativa.examKey, titulo: evalTitle(memory, ativa.examKey),
            status: ativa.status, entregues, total: students.length, endsAt: ativa.endsAt || null,
        };
    }
    // `startsAt` da aplicação, nunca o estado ativo da turma — database.js reseta
    // `activeExamKey` a cada boot, então o estado ativo não sobrevive a reinícios.
    const futuras = apps
        .filter(a => ['prepared', 'waiting'].includes(a.status) && Number(a.startsAt) > now)
        .sort((a, b) => Number(a.startsAt) - Number(b.startsAt));
    const proximaAplicacao = futuras[0]
        ? { id: futuras[0].id, titulo: evalTitle(memory, futuras[0].examKey), startsAt: Number(futuras[0].startsAt) }
        : null;

    // "0 conectados" precisa de janela e da última leitura — sessions não é
    // persistido, então zero sem contexto é indistinguível de reboot do servidor.
    let count = 0, ultimoAcessoAt = null;
    students.forEach(s => {
        const sess = (memory.sessions || {})[s.email] || (memory.sessions || {})[lower(s.email)];
        const ts = typeof sess === 'number' ? sess : (sess && (sess.lastSeen || sess.lastPing)) || null;
        if (ts == null) return;
        if (now - ts <= ONLINE_JANELA_MIN * 60000) count++;
        if (ultimoAcessoAt == null || ts > ultimoAcessoAt) ultimoAcessoAt = ts;
    });

    return { aula, proximaAula, aplicacao, proximaAplicacao, online: { count, janelaMin: ONLINE_JANELA_MIN, ultimoAcessoAt } };
}

// ---------------------------------------------------------------------------
// PRECISA DE VOCÊ — cada item é uma pendência com destino clicável.
// `canSeeMatriculas` vem da rota (admin pleno); snooze é aplicado na rota.
// ---------------------------------------------------------------------------
function computeQueue({ memory, cls, course, students, today, now, canSeeMatriculas }) {
    const emails = emailSet(students);
    const items = [];

    // 1. Chamada de hoje não concluída (só em dia letivo).
    const grade = cls ? attendanceUtil.gradeForDate(cls, today) : [];
    if (grade.length && students.length) {
        const status = chamadaStatusHoje(memory, cls, emails, today);
        if (status !== 'concluida') {
            items.push({
                id: 'chamada_pendente', tipo: 'chamada_pendente',
                titulo: status === 'rascunho' ? 'Chamada de hoje salva como rascunho' : 'Chamada de hoje não lançada',
                detalhe: `${grade.length} ${grade.length === 1 ? 'aula' : 'aulas'} na grade de hoje · Chamada`,
                count: grade.length, tone: 'danger', href: '/chamada', permissao: 'page.dashboard',
            });
        }
    }

    // 2. Dúvidas sem resposta do instrutor há mais de 24h.
    const cutoff = now - DIA_MS;
    const paradas = (memory.forum || []).filter(c => {
        if (c.deleted) return false;
        if (cls && c.studentClass && c.studentClass !== cls.name) return false;
        if (course && c.courseId && String(c.courseId) !== String(course.id)) return false;
        if (c.studentEmail && emails.size && !emails.has(lower(c.studentEmail))) return false;
        if (c.status === 'respondida' || c.status === 'resolvida') return false;
        if ((c.replies || []).some(r => !r.deleted && r.authorRole === 'Instrutor')) return false;
        const ts = tsOf(c.timestamp);
        return ts != null && ts < cutoff;
    });
    if (paradas.length) {
        items.push({
            id: 'duvidas_paradas', tipo: 'duvidas_paradas',
            titulo: 'Dúvidas sem resposta há mais de 24 h',
            detalhe: 'aguardando o instrutor · Fórum',
            count: paradas.length, tone: 'warning', href: '/forum', permissao: 'page.forum',
        });
    }

    // 3. Alunos sem nenhuma avaliação no curso.
    const avaliados = new Set((memory.submissions || [])
        .filter(s => s.student && (!course || !s.student.courseId || String(s.student.courseId) === String(course.id)))
        .map(s => lower(s.student.email)));
    const semAvaliacao = students.filter(s => !avaliados.has(lower(s.email)));
    if (semAvaliacao.length) {
        items.push({
            id: 'sem_avaliacao', tipo: 'sem_avaliacao',
            titulo: 'Alunos sem nenhuma avaliação',
            detalhe: 'nunca entregaram prova neste curso · Resultados',
            count: semAvaliacao.length, tone: 'info', href: '/resultados', permissao: 'page.results',
        });
    }

    // 4. Matrículas pendentes — visível apenas para administrador pleno.
    if (canSeeMatriculas) {
        const pendentes = students.reduce((sum, s) =>
            sum + ((s.enrollmentRequests || []).filter(r => r.status === 'pending').length), 0);
        if (pendentes) {
            items.push({
                id: 'matriculas', tipo: 'matriculas',
                titulo: 'Solicitações de matrícula pendentes',
                detalhe: 'visível apenas para administrador · Matrículas',
                count: pendentes, tone: 'early', href: '/matriculas', permissao: 'page.students',
            });
        }
    }

    // 5. Conteúdo bloqueado de unidade com prova agendada em até 7 dias — o único
    // cruzamento (releasedItems × examApplications.startsAt) que nenhuma tela faz.
    if (cls && course) {
        const emBreve = classApplications(memory, cls, course).filter(a =>
            ['prepared', 'waiting'].includes(a.status)
            && Number(a.startsAt) > now && Number(a.startsAt) <= now + 7 * DIA_MS);
        const released = cls.releasedItems || {};
        let bloqueados = 0; let unidade = '';
        emBreve.forEach(app => {
            (course.structure || []).forEach(mod => (mod.units || []).forEach(unit => {
                if (unit.avaliacaoKey !== app.examKey) return;
                const keys = [unit.apostilaKey, ...(unit.files || []).map(f => f.key)].filter(Boolean);
                const faltam = keys.filter(k => !released[k]).length;
                if (faltam) { bloqueados += faltam; unidade = unit.name || unidade; }
            }));
        });
        if (bloqueados) {
            items.push({
                id: 'conteudo_bloqueado', tipo: 'conteudo_bloqueado',
                titulo: unidade ? `Conteúdo de "${unidade}" ainda bloqueado` : 'Conteúdo de unidade com prova próxima bloqueado',
                detalhe: 'a prova desta unidade acontece em até 7 dias · Materiais',
                count: bloqueados, tone: 'neutral', href: '/materiais', permissao: 'page.materials',
            });
        }
    }

    // 6. Provas com tempo esgotado recuperadas depois do encerramento da aplicação
    // (tentativas que versões antigas deixavam sem entrega). Entram "em revisão" e
    // podem passar despercebidas quando as notas da aplicação já foram publicadas.
    const recuperadas = (memory.submissions || []).filter(s => s
        && s.recoveredAfterFinish === true
        && s.gradePublished !== true
        && !['archived', 'invalidated'].includes(s.resultStatus)
        && s.student && emails.has(lower(s.student.email))
        && (!course || !s.student.courseId || String(s.student.courseId) === String(course.id))
        && (!cls || !s.student.studentClass || s.student.studentClass === cls.name));
    if (recuperadas.length) {
        items.push({
            id: 'provas_recuperadas', tipo: 'provas_recuperadas',
            titulo: 'Provas recuperadas depois do encerramento',
            detalhe: 'entregues com as respostas salvas no fim do tempo, aguardando revisão · Resultados',
            count: recuperadas.length, tone: 'warning', href: '/resultados', permissao: 'page.results',
        });
    }

    return items;
}

// ---------------------------------------------------------------------------
// PULSO — 3 métricas com tendência (janela móvel de 30 dias vs. 30 anteriores).
// Série: 6 fatias de 5 dias, para a sparkline ter eixo temporal real.
// ---------------------------------------------------------------------------
function computeTrends({ memory, students, course, cls, now }) {
    const emails = emailSet(students);
    const courseId = course ? String(course.id) : '';
    const inWin = (ts, startDaysAgo, endDaysAgo) =>
        ts != null && ts > now - startDaysAgo * DIA_MS && ts <= now - endDaysAgo * DIA_MS;
    const sliceLabel = (startDaysAgo) => {
        const d = new Date(now - startDaysAgo * DIA_MS);
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    // ---- Frequência (por aula; dedupe por aluno+data; escopo do curso) ----
    const attScoped = (memory.attendance || []).filter(a => emails.has(lower(a.studentEmail))
        && (!courseId || !a.courseId || String(a.courseId) === courseId));
    const attByStudent = new Map();
    attScoped.forEach(a => {
        const e = lower(a.studentEmail);
        if (!attByStudent.has(e)) attByStudent.set(e, []);
        attByStudent.get(e).push(a);
    });
    const dedupedAll = [];
    attByStudent.forEach(list => { attendanceUtil.dedupeByDate(list).forEach(r => dedupedAll.push(r)); });

    const freqPct = (records) => {
        const stats = attendanceUtil.computeAttendanceStats(records);
        return stats.frequenciaGeral; // null quando não há aulas na janela
    };
    const recIn = (startDaysAgo, endDaysAgo) =>
        dedupedAll.filter(r => inWin(tsOf(`${r.date}T12:00:00Z`), startDaysAgo, endDaysAgo));
    const freqAtual = freqPct(recIn(30, 0));
    const freqAnterior = freqPct(recIn(60, 30));
    const freqSerie = [];
    for (let i = 5; i >= 0; i--) freqSerie.push({ label: sliceLabel(i * 5 + 5), valor: freqPct(recIn(i * 5 + 5, i * 5)) });
    const comChamada = new Set(dedupedAll.map(r => lower(r.studentEmail))).size;

    // ---- Média das provas (timestamp ISO normalizado na entrada) ----
    const subsScoped = (memory.submissions || []).filter(s => s.student && emails.has(lower(s.student.email))
        && (!courseId || !s.student.courseId || String(s.student.courseId) === courseId));
    const mediaOf = (subs) => {
        if (!subs.length) return null;
        return Math.round(subs.reduce((a, s) => a + (Number(s.score) || 0), 0) / subs.length / 10 * 10) / 10;
    };
    const subsIn = (startDaysAgo, endDaysAgo) => subsScoped.filter(s => inWin(tsOf(s.timestamp), startDaysAgo, endDaysAgo));
    const mediaAtual = mediaOf(subsIn(30, 0));
    const mediaAnterior = mediaOf(subsIn(60, 30));
    const mediaSerie = [];
    for (let i = 5; i >= 0; i--) mediaSerie.push({ label: sliceLabel(i * 5 + 5), valor: mediaOf(subsIn(i * 5 + 5, i * 5)) });
    const alunosAvaliados = new Set(subsScoped.map(s => lower(s.student.email))).size;

    // ---- Engajamento (moduleAccess em ms + presença como acesso) ----
    const accScoped = (memory.moduleAccess || []).filter(m => emails.has(lower(m.studentEmail)));
    const distinctIn = (startDaysAgo, endDaysAgo) =>
        new Set(accScoped.filter(m => inWin(tsOf(m.timestamp), startDaysAgo, endDaysAgo)).map(m => lower(m.studentEmail))).size;
    const engAtual = distinctIn(7, 0);
    const engAnterior = distinctIn(14, 7);
    const engSerie = [];
    for (let i = 5; i >= 0; i--) engSerie.push({ label: sliceLabel(i * 7 + 7), valor: distinctIn(i * 7 + 7, i * 7) });
    const lastAccessOf = (s) => {
        const acc = accScoped.filter(m => lower(m.studentEmail) === lower(s.email)).map(m => tsOf(m.timestamp));
        const login = tsOf(s.lastLoginAt) || tsOf(s.lastSeenAt);
        return Math.max(login || 0, ...(acc.length ? acc : [0])) || null;
    };
    const semAcessoMais14d = students.filter(s => {
        const ts = lastAccessOf(s);
        return ts == null || now - ts > 14 * DIA_MS;
    }).length;

    // ---- Frequência por disciplina (D5: condicionada à cobertura) ----
    // Só faz sentido exibir se a maioria dos registros tiver disciplinaId —
    // senão o recorte mostraria 16 de 223 aulas como se fosse a turma inteira.
    const limiar = attendanceUtil.effectiveAttendanceConfig(cls).limiarRiscoPct;
    const statsAll = attendanceUtil.computeAttendanceStats(dedupedAll);
    let comDisciplina = 0, totalAulasReg = 0;
    dedupedAll.forEach(r => attendanceUtil.recordAulas(r).forEach(a => { totalAulasReg++; if (a.disciplinaId) comDisciplina++; }));
    const discNomes = discNameMap(course);
    const disciplinas = {
        cobertura: { comDisciplina, total: totalAulasReg },
        exibir: totalAulasReg > 0 && comDisciplina / totalAulasReg >= 0.5,
        limiar,
        itens: Object.entries(statsAll.porDisciplina || {})
            .filter(([did]) => did)
            .map(([did, v]) => ({
                disciplinaId: did, nome: discNomes[did] || did,
                frequencia: v.frequencia, presentes: v.presentes, faltas: v.faltas, total: v.total,
                emRisco: v.frequencia != null && v.frequencia < limiar,
            }))
            .sort((a, b) => (a.frequencia ?? 101) - (b.frequencia ?? 101)),
    };

    const round1 = v => v == null ? null : Math.round(v * 10) / 10;
    return {
        disciplinas,
        frequencia: {
            atual: freqAtual, anterior: freqAnterior,
            deltaPP: (freqAtual != null && freqAnterior != null) ? freqAtual - freqAnterior : null,
            serie: freqSerie, base: { comChamada, total: students.length },
        },
        media: {
            atual: mediaAtual, anterior: mediaAnterior,
            delta: (mediaAtual != null && mediaAnterior != null) ? round1(mediaAtual - mediaAnterior) : null,
            serie: mediaSerie, base: { provas: subsScoped.length, alunos: alunosAvaliados },
        },
        engajamento: {
            atual: engAtual, total: students.length, anterior: engAnterior,
            serie: engSerie, semAcessoMais14d,
        },
    };
}

module.exports = { computeNow, computeQueue, computeTrends };
