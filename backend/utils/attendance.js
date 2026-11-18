// ============================================================================
// Utilidades de PRESENÇA POR AULA (grade horária + frequência por disciplina)
// Compartilhado entre rotas (admin/student) e analytics. Sem estado.
// ============================================================================

const WEEKDAYS = ['0', '1', '2', '3', '4', '5', '6']; // 0=dom … 6=sáb
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const AULA_STATUS = ['presente', 'falta', 'justificada'];
const JUST_TIPOS = ['atestado', 'responsavel', 'declaracao', 'outro'];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function configDefault() {
    return { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} };
}

// Normaliza a lista de disciplinas de um curso (id único, nome, cor opcional).
function sanitizeDisciplinas(input) {
    if (!Array.isArray(input)) return null;
    const seen = new Set();
    const out = [];
    for (const d of input) {
        const id = String((d && d.id) || '').trim().toUpperCase().slice(0, 16);
        const nome = String((d && d.nome) || '').trim().slice(0, 60);
        if (!id || !nome || seen.has(id)) continue;
        seen.add(id);
        const cor = /^#[0-9a-fA-F]{6}$/.test((d && d.cor) || '') ? d.cor : '';
        out.push({ id, nome, cor });
    }
    return out;
}

// Normaliza os modelos de grade reutilizáveis de um curso. Cada modelo guarda o
// suficiente para repopular o assistente (ritmo + dias + grade + disciplinas).
function sanitizeGradeTemplates(input) {
    if (!Array.isArray(input)) return null;
    const clampInt = (v, min, max, fallback) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const seen = new Set();
    const out = [];
    for (const t of input.slice(0, 50)) {
        if (!t || typeof t !== 'object') continue;
        const id = String(t.id || '').trim().slice(0, 40);
        const nome = String(t.nome || '').trim().slice(0, 60);
        if (!id || !nome || seen.has(id)) continue;
        seen.add(id);
        const r = (t.rhythm && typeof t.rhythm === 'object') ? t.rhythm : {};
        const count = clampInt(r.count, 1, 12, 5);
        const rhythm = {
            start: HHMM_RE.test(String(r.start || '')) ? r.start : '07:00',
            duration: clampInt(r.duration, 5, 600, 50),
            count,
            defaultGap: clampInt(r.defaultGap, 0, 600, 10),
            gaps: Array.isArray(r.gaps) ? r.gaps.slice(0, count - 1).map(g => clampInt(g, 0, 600, 10)) : [],
        };
        const days = {};
        const grid = {};
        for (const wd of WEEKDAYS) {
            days[wd] = !!(t.days && t.days[wd]);
            const row = (t.grid && Array.isArray(t.grid[wd])) ? t.grid[wd] : [];
            grid[wd] = Array.from({ length: count }, (_, i) => String(row[i] || '').trim().toUpperCase().slice(0, 16));
        }
        const subjectIds = Array.isArray(t.subjectIds)
            ? [...new Set(t.subjectIds.map(s => String(s || '').trim().toUpperCase().slice(0, 16)).filter(Boolean))].slice(0, 60)
            : [];
        out.push({ id, nome, rhythm, days, grid, subjectIds });
    }
    return out;
}

// Normaliza a configuração de presença da turma. `disciplinaIds` (Set) é
// opcional: quando informado, disciplinas fora da lista do curso são zeradas.
function sanitizeAttendanceConfig(input, disciplinaIds) {
    if (input == null || typeof input !== 'object') return null;
    const tol = Number(input.toleranciaMin);
    const lim = Number(input.limiarRiscoPct);
    const cfg = {
        toleranciaMin: Number.isFinite(tol) && tol >= 0 && tol <= 240 ? Math.round(tol) : 10,
        limiarRiscoPct: Number.isFinite(lim) && lim >= 0 && lim <= 100 ? Math.round(lim) : 75,
        grade: {},
    };
    const grade = (input.grade && typeof input.grade === 'object') ? input.grade : {};
    for (const wd of WEEKDAYS) {
        const arr = grade[wd];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const aulas = [];
        const ordens = new Set();
        arr.forEach((a, i) => {
            const ordem = Number(a && a.ordem) || (i + 1);
            if (ordens.has(ordem)) return;
            const inicio = HHMM_RE.test((a && a.inicio) || '') ? a.inicio : '';
            let disciplinaId = String((a && a.disciplinaId) || '').trim().toUpperCase().slice(0, 16);
            if (disciplinaId && disciplinaIds && !disciplinaIds.has(disciplinaId)) disciplinaId = '';
            ordens.add(ordem);
            aulas.push({ ordem, inicio, disciplinaId });
        });
        aulas.sort((a, b) => a.ordem - b.ordem);
        if (aulas.length) cfg.grade[wd] = aulas;
    }
    return cfg;
}

// Config efetiva de uma turma, com defaults para turmas sem `attendanceConfig`.
function effectiveAttendanceConfig(cls) {
    const base = configDefault();
    if (!cls || !cls.attendanceConfig || typeof cls.attendanceConfig !== 'object') return base;
    const c = cls.attendanceConfig;
    return {
        toleranciaMin: Number.isFinite(Number(c.toleranciaMin)) ? Number(c.toleranciaMin) : base.toleranciaMin,
        limiarRiscoPct: Number.isFinite(Number(c.limiarRiscoPct)) ? Number(c.limiarRiscoPct) : base.limiarRiscoPct,
        grade: (c.grade && typeof c.grade === 'object') ? c.grade : {},
    };
}

// Dia da semana (0=dom … 6=sáb) de uma data 'YYYY-MM-DD' (sem fuso).
function weekdayOf(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

// Grade (array de aulas) de uma turma numa data. [] se dia não letivo.
function gradeForDate(cls, dateStr) {
    const cfg = effectiveAttendanceConfig(cls);
    const wd = weekdayOf(dateStr);
    if (wd == null) return [];
    const aulas = cfg.grade[String(wd)];
    return Array.isArray(aulas) ? aulas : [];
}

function hhmmToMin(hhmm) {
    const str = String(hhmm || '');
    if (!HHMM_RE.test(str)) return null;
    const [h, m] = str.split(':');
    return (+h) * 60 + (+m);
}

// Deriva o status por aula a partir da hora de chegada + tolerância.
// Aula sem horário de início não pode ser derivada ⇒ 'presente' (não pune).
function deriveAulasFromArrival(gradeAulas, horaChegada, toleranciaMin) {
    const chegada = hhmmToMin(horaChegada);
    const tol = Number.isFinite(Number(toleranciaMin)) ? Number(toleranciaMin) : 10;
    return (gradeAulas || []).map(a => {
        const inicioMin = hhmmToMin(a.inicio);
        let status = 'presente';
        if (chegada != null && inicioMin != null && chegada > inicioMin + tol) status = 'falta';
        return { ordem: a.ordem, disciplinaId: a.disciplinaId || '', inicio: a.inicio || '', status, hora: status === 'presente' ? '' : horaChegada };
    });
}

// Janela das aulas do dia para a presença automática (FUN-X2, CRIT-02): do início da
// primeira aula menos a tolerância da turma até o fim da última. A grade guarda só o
// início de cada aula; a duração é o menor intervalo entre inícios (50 min se houver
// uma aula só). Sem horário na grade não há janela: o acesso não marca nada.
const DEFAULT_AULA_MIN = 50;
function classDayWindow(gradeAulas, toleranciaMin) {
    const starts = (gradeAulas || []).map(a => hhmmToMin(a && a.inicio)).filter(v => v != null).sort((x, y) => x - y);
    if (!starts.length) return null;
    const gaps = [];
    for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1];
        if (gap > 0) gaps.push(gap);
    }
    const duracao = gaps.length ? Math.min(...gaps) : DEFAULT_AULA_MIN;
    const tol = Number.isFinite(Number(toleranciaMin)) && Number(toleranciaMin) >= 0 ? Number(toleranciaMin) : 10;
    return { inicioMin: Math.max(0, starts[0] - tol), fimMin: starts[starts.length - 1] + duracao };
}

// O horário (HH:MM) está dentro da janela das aulas do dia?
function withinClassDayWindow(gradeAulas, toleranciaMin, hhmm) {
    const janela = classDayWindow(gradeAulas, toleranciaMin);
    const agora = hhmmToMin(hhmm);
    return !!janela && agora != null && agora >= janela.inicioMin && agora <= janela.fimMin;
}

// Uma aula justificada só deixa de contar como falta quando a justificativa
// do dia está abonada. Falta pura sempre conta.
function aulaCountsAsFalta(aula, justificativa) {
    const st = String((aula && aula.status) || '').toLowerCase();
    if (st === 'falta') return true;
    if (st === 'justificada') return !(justificativa && justificativa.abonado === true);
    return false;
}

// Normaliza um registro (novo ou legado) para um array de aulas com disciplina.
// Registro legado (sem `aulas[]`) vira 1 aula sem disciplina, status derivado.
function recordAulas(rec) {
    if (rec && Array.isArray(rec.aulas) && rec.aulas.length) return rec.aulas;
    const legacyStatus = String((rec && rec.status) || 'presente').toLowerCase();
    let status = 'presente';
    if (legacyStatus === 'ausente') status = 'falta';
    else if (legacyStatus === 'justificado') status = 'justificada';
    else status = 'presente'; // presente/atrasado
    return [{ ordem: 1, disciplinaId: '', inicio: '', status, hora: '' }];
}

// Normaliza o array de aulas recebido do cliente (chamada). Ordem única.
function sanitizeAulas(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    input.forEach((a, i) => {
        const ordem = Number(a && a.ordem) || (i + 1);
        if (seen.has(ordem)) return;
        seen.add(ordem);
        let status = String((a && a.status) || 'presente').toLowerCase();
        if (!AULA_STATUS.includes(status)) status = 'presente';
        const disciplinaId = String((a && a.disciplinaId) || '').trim().toUpperCase().slice(0, 16);
        const inicio = HHMM_RE.test((a && a.inicio) || '') ? a.inicio : '';
        const hora = HHMM_RE.test((a && a.hora) || '') ? a.hora : '';
        out.push({ ordem, disciplinaId, inicio, status, hora });
    });
    out.sort((x, y) => x.ordem - y.ordem);
    return out;
}

// Normaliza a justificativa (nível do dia). null quando ausente/sem status J.
function sanitizeJustificativa(input) {
    if (!input || typeof input !== 'object') return null;
    const tipo = JUST_TIPOS.includes(String(input.tipo)) ? input.tipo : 'atestado';
    return {
        tipo,
        de: YMD_RE.test(input.de || '') ? input.de : '',
        ate: YMD_RE.test(input.ate || '') ? input.ate : '',
        abonado: input.abonado === true,
        texto: String(input.texto || '').slice(0, 500),
        arquivo: String(input.arquivo || '').slice(0, 500),
        arquivoNome: String(input.arquivoNome || '').slice(0, 200),
    };
}

// True se o registro do dia tem ao menos uma aula presente (para streak/dias ativos).
function recordHasPresence(rec) {
    return recordAulas(rec).some(a => a.status === 'presente');
}

// Mantém 1 registro por curso/turma/data, preferindo a chamada do professor
// sobre marca manual e login automático. Evita dupla contagem na frequência.
const ORIGIN_RANK = { chamada: 3, manual: 2, login: 1 };
function dedupeByDate(records) {
    const best = new Map();
    (records || []).forEach(r => {
        const key = `${r.courseId || ''}::${r.studentClass || ''}::${r.date || r.id}`;
        const cur = best.get(key);
        if (!cur || (ORIGIN_RANK[r.origin] || 0) >= (ORIGIN_RANK[cur.origin] || 0)) best.set(key, r);
    });
    return [...best.values()];
}

const _freqPct = (p, f) => (p + f) ? Math.round((p / (p + f)) * 100) : null;

// Estatística de frequência por aula: geral + por disciplina.
// Denominador = aulas lançadas que contam (presente + falta não abonada).
// Aulas abonadas ficam de fora do numerador e do denominador.
function computeAttendanceStats(records) {
    let presentes = 0, faltasContam = 0;
    const disc = {};
    (records || []).forEach(rec => {
        const just = rec.justificativa || null;
        recordAulas(rec).forEach(a => {
            const did = a.disciplinaId || '';
            const d = disc[did] || (disc[did] = { presentes: 0, faltas: 0 });
            if (a.status === 'presente') { presentes++; d.presentes++; }
            else if (aulaCountsAsFalta(a, just)) { faltasContam++; d.faltas++; }
        });
    });
    const porDisciplina = {};
    Object.entries(disc).forEach(([did, v]) => {
        porDisciplina[did] = { presentes: v.presentes, faltas: v.faltas, total: v.presentes + v.faltas, frequencia: _freqPct(v.presentes, v.faltas) };
    });
    return {
        presentes, faltasContam, totalAulas: presentes + faltasContam,
        frequenciaGeral: _freqPct(presentes, faltasContam),
        porDisciplina,
    };
}

module.exports = {
    WEEKDAYS, HHMM_RE, AULA_STATUS, JUST_TIPOS,
    configDefault, sanitizeDisciplinas, sanitizeGradeTemplates, sanitizeAttendanceConfig,
    effectiveAttendanceConfig, weekdayOf, gradeForDate,
    hhmmToMin, deriveAulasFromArrival, aulaCountsAsFalta, recordAulas,
    classDayWindow, withinClassDayWindow,
    sanitizeAulas, sanitizeJustificativa, recordHasPresence, computeAttendanceStats,
    dedupeByDate,
};
