// ============================================================================
// Utilidades de PRESENÇA POR AULA (grade horária + frequência por disciplina)
// Compartilhado entre rotas (admin/student) e analytics. Sem estado.
// No fim, as versões da presença (H7b): fotografia, resumo e quando auditar.
// ============================================================================

const { recordAudit } = require('./audit.js');

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

// ============================================================================
// Versões da presença (H7b; CONF-09, FUN-04)
// A chamada do dia é regravada inteira a cada salvamento: o registro do aluno naquele
// dia sai e volta com id novo (inclusive o da presença automática do login), como
// sempre foi. Para o valor anterior não se perder, a mudança que importa vira uma
// entrada da auditoria (attendance_changed) com a fotografia dos registros que saíram
// e do que entrou. O formato de attendance não muda; só ganha dois campos opcionais:
// - concludedAt: hora da primeira conclusão da chamada daquele dia, que passa de
//   versão em versão (o autosave de rascunho depois de concluir não a apaga);
// - loginAccess: { horaAcesso, ip, source } do registro automático do login que a
//   chamada substituiu, também passado adiante;
// - baseVersion: { origin, markedBy, timestamp } da versão de referência da regra de
//   quando auditar (a que a auditoria já conhece): a presença automática do login, a
//   marcação individual, a primeira chamada do dia ou a última mudança que virou
//   entrada. A tela da Chamada manda a turma inteira a cada autosave, e cada aluno volta
//   com o markedBy e a hora de quem salvou, mesmo sem mudar nada. Sem este campo, a
//   origem, o autor e a idade da situação se perdiam no primeiro autosave e a mudança
//   seguinte (sobre a presença do login, de outra pessoa ou de mais de 15 min) passava
//   como rascunho. Só a chamada leva o campo, e só quando a referência não é o próprio
//   registro (mesma origem, autor e hora).
// Registro antigo sem esses campos vale como "nunca concluído", "sem login guardado" e
// "a referência é o próprio registro" (o concluida: true gravado antes deles ainda conta
// como concluído).
// ============================================================================

// Edição contínua do mesmo professor: o autosave da Chamada grava a cada 2 s, e cada
// rascunho dentro desta janela não vira entrada da auditoria.
const ATTENDANCE_EDIT_SESSION_MS = 15 * 60 * 1000;

const JUST_TIPO_LABELS = { atestado: 'atestado', responsavel: 'responsável', declaracao: 'declaração', outro: 'outro motivo' };

// Hora gravada (ms ou texto ISO) em ms; ausente ou inválida vira null.
function validTime(value) {
    let n = NaN;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim()) n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function emailOf(actor) {
    const value = actor && typeof actor === 'object' ? actor.email : actor;
    return String(value ?? '').trim().toLowerCase();
}

// Aulas do registro (legado vira 1 aula) só com ordem e situação, em ordem de aula.
function aulaStatuses(rec) {
    return recordAulas(rec)
        .map(a => ({ ordem: Number(a && a.ordem) || 0, status: String((a && a.status) || '').toLowerCase() }))
        .sort((x, y) => x.ordem - y.ordem);
}

// Fotografia do registro para a auditoria: quem marcou, quando, por onde e a situação
// de cada aula. Sem o texto da justificativa, o comprovante, a observação, o IP e o
// navegador (a auditoria fica com o que mudou, não com o dado pessoal do aluno).
function attendanceSnapshot(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const just = rec.justificativa && typeof rec.justificativa === 'object' ? rec.justificativa : null;
    const snapshot = {
        id: rec.id === undefined ? null : rec.id,
        origin: String(rec.origin || ''),
        concluida: rec.concluida === true,
        markedBy: rec.markedBy === undefined ? null : rec.markedBy,
        timestamp: validTime(rec.timestamp),
        aulas: aulaStatuses(rec),
        justificativa: just ? {
            tipo: String(just.tipo || ''),
            abonado: just.abonado === true,
            temTexto: !!String(just.texto || '').trim(),
            temArquivo: !!String(just.arquivo || '').trim(),
        } : null,
        temObservacao: !!String(rec.observacao || '').trim(),
    };
    const concludedAt = validTime(rec.concludedAt);
    if (concludedAt) snapshot.concludedAt = concludedAt;
    // De onde vinha a situação regravada pelo autosave (ex.: a presença do login).
    if (rec.origin === 'chamada' && rec.baseVersion && typeof rec.baseVersion === 'object') {
        snapshot.baseVersion = attendanceBaseVersion(rec);
    }
    return snapshot;
}

// O que conta como "a presença mudou": a situação de cada aula e, havendo aula
// justificada, o tipo e o abono da justificativa (o abono muda a frequência). Texto da
// justificativa, observação, hora de chegada e conclusão da chamada não entram.
function statusKey(rec) {
    if (!rec || typeof rec !== 'object') return '';
    const aulas = aulaStatuses(rec);
    let key = aulas.map(a => `${a.ordem}:${a.status}`).join(',');
    if (aulas.some(a => a.status === 'justificada')) {
        const just = rec.justificativa && typeof rec.justificativa === 'object' ? rec.justificativa : null;
        key += `|j:${just ? String(just.tipo || '') : ''}:${just && just.abonado === true ? 1 : 0}`;
    }
    return key;
}

function countText(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

function joinWithE(parts) {
    if (parts.length <= 1) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

// Resumo em português para a auditoria (Antes → Depois): "Presente (2 aulas)", "Falta",
// "1 presença e 1 falta (2 aulas)", "Falta justificada (atestado, abonada)".
function describe(rec) {
    if (!rec || typeof rec !== 'object') return 'Sem registro';
    const aulas = aulaStatuses(rec);
    const total = aulas.length;
    const count = { presente: 0, falta: 0, justificada: 0 };
    aulas.forEach(a => { if (Object.prototype.hasOwnProperty.call(count, a.status)) count[a.status] += 1; });
    const kinds = Object.keys(count).filter(k => count[k] > 0);
    let text;
    if (kinds.length === 1 && count[kinds[0]] === total) {
        text = { presente: 'Presente', falta: 'Falta', justificada: 'Falta justificada' }[kinds[0]];
    } else {
        const parts = [];
        if (count.presente) parts.push(countText(count.presente, 'presença', 'presenças'));
        if (count.falta) parts.push(countText(count.falta, 'falta', 'faltas'));
        if (count.justificada) parts.push(countText(count.justificada, 'falta justificada', 'faltas justificadas'));
        text = parts.length ? joinWithE(parts) : 'Sem aulas lançadas';
        if (parts.length) text = text.charAt(0).toUpperCase() + text.slice(1);
    }
    const notes = [];
    if (total > 1) notes.push(`${total} aulas`);
    if (count.justificada) {
        const just = rec.justificativa && typeof rec.justificativa === 'object' ? rec.justificativa : null;
        if (just && JUST_TIPO_LABELS[just.tipo]) notes.push(JUST_TIPO_LABELS[just.tipo]);
        notes.push(just && just.abonado === true ? 'abonada' : 'não abonada');
    }
    return notes.length ? `${text} (${notes.join(', ')})` : text;
}

// O registro que vale naquele dia (o mesmo que dedupeByDate escolhe): a chamada sobre a
// marcação manual, a manual sobre a do login; empate, o último da lista.
function effectiveDayRecord(records) {
    let best = null;
    (records || []).forEach(r => {
        if (!r || typeof r !== 'object') return;
        if (!best || (ORIGIN_RANK[r.origin] || 0) >= (ORIGIN_RANK[best.origin] || 0)) best = r;
    });
    return best;
}

// Versão de referência de um registro (ver baseVersion no começo desta seção): a guardada
// na chamada regravada ou, sem ela (login, marcação individual, registro antigo, ou a
// chamada que é a própria referência), o próprio registro.
function attendanceBaseVersion(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const stored = rec.origin === 'chamada' && rec.baseVersion && typeof rec.baseVersion === 'object' ? rec.baseVersion : null;
    const from = stored || rec;
    return {
        origin: String(from.origin || '').slice(0, 20),
        markedBy: from.markedBy == null ? null : String(from.markedBy).slice(0, 200),
        timestamp: validTime(from.timestamp),
    };
}

// Quando a regravação da chamada vira entrada da auditoria. Só se a situação mudou e:
// - a chamada já tinha sido concluída (concluida: true ou concludedAt); ou
// - a situação não veio da chamada (presença automática do login ou marcação individual,
//   mesmo que um autosave já tenha regravado o aluno sem mudar nada); ou
// - quem salva agora não é quem marcou a situação; ou
// - a versão de referência tem mais de 15 min (ATTENDANCE_EDIT_SESSION_MS). A janela
//   não anda com o autosave: conta da referência (a primeira chamada do dia ou a última
//   mudança que virou entrada), e o rascunho que não vira entrada não a renova.
// Tudo isso pela versão de referência (attendanceBaseVersion), não pelo markedBy e pela
// hora da última regravação. A primeira chamada do dia (sem registro anterior) e o
// rascunho do mesmo professor antes de concluir, dentro dos 15 min, não geram entrada.
function shouldAuditAttendanceChange(prev, next, actor, now = Date.now()) {
    if (!prev || typeof prev !== 'object') return false;
    if (statusKey(prev) === statusKey(next)) return false;
    if (prev.concluida === true || validTime(prev.concludedAt)) return true;
    const base = attendanceBaseVersion(prev);
    if (base.origin !== 'chamada') return true;
    if (emailOf(base.markedBy) !== emailOf(actor)) return true;
    if (!base.timestamp) return true;
    return Number(now) - base.timestamp > ATTENDANCE_EDIT_SESSION_MS;
}

// Versão de referência do registro novo da chamada, depois da decisão de auditar: o
// próprio registro quando é a primeira chamada do dia ou quando a mudança virou entrada;
// senão (situação igual, ou rascunho do mesmo professor), a referência anterior. Devolve
// { baseVersion } só quando a referência não é o próprio registro, para espalhar nele.
function attendanceBaseVersionFields(prev, record, { audited = false } = {}) {
    if (!prev || audited || !record) return {};
    const base = attendanceBaseVersion(prev);
    const own = attendanceBaseVersion({ origin: record.origin, markedBy: record.markedBy, timestamp: record.timestamp });
    if (base.origin === own.origin && emailOf(base.markedBy) === emailOf(own.markedBy) && base.timestamp === own.timestamp) return {};
    return { baseVersion: base };
}

// Campos que passam da versão anterior para a nova regravação da chamada:
// - concludedAt: a primeira conclusão (a mais antiga entre os registros que saem). Um
//   registro concluído de antes deste campo conta pela hora em que foi gravado, a mais
//   antiga que se conhece; sem nenhuma, a hora de agora se esta gravação conclui.
// - loginAccess: o acesso guardado numa versão anterior ou, na primeira vez, o do
//   registro automático do login que a chamada substitui.
// Devolve só os campos que existem (nada de chave com undefined no registro).
function attendanceCarryOver(previous, { concluida = false, now = Date.now() } = {}) {
    const carried = {};
    let concludedAt = null;
    let loginAccess = null;
    (previous || []).forEach(r => {
        if (!r || typeof r !== 'object') return;
        const concluded = validTime(r.concludedAt) || (r.concluida === true ? validTime(r.timestamp) : null);
        if (concluded && (!concludedAt || concluded < concludedAt)) concludedAt = concluded;
        if (!loginAccess && r.loginAccess && typeof r.loginAccess === 'object') {
            loginAccess = {
                horaAcesso: String(r.loginAccess.horaAcesso || ''),
                ip: String(r.loginAccess.ip || ''),
                source: r.loginAccess.source === 'heartbeat' ? 'heartbeat' : 'login',
            };
        }
    });
    if (!loginAccess) {
        const login = (previous || []).find(r => r && r.origin === 'login');
        if (login) {
            loginAccess = {
                horaAcesso: String(login.horaAcesso || ''),
                ip: String(login.ip || ''),
                source: login.source === 'heartbeat' ? 'heartbeat' : 'login',
            };
        }
    }
    if (!concludedAt && concluida === true) concludedAt = Number(now);
    if (concludedAt) carried.concludedAt = concludedAt;
    if (loginAccess) carried.loginAccess = loginAccess;
    return carried;
}

// 'AAAA-MM-DD' → 'DD/MM/AAAA' (campo da entrada na auditoria).
function formatDateBR(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(date || '');
}

// Grava na auditoria a mudança de presença de um aluno num dia (recordAudit, categoria
// 'attendance'). action: 'attendance_changed' (chamada regravada) ou
// 'attendance_marked' (marcação individual). before: os registros do dia que existiam
// antes; after: o registro novo. Antes → Depois em texto (describe) pelo registro que
// valia e pelo novo; details guarda as fotografias. Quando o novo não passa a valer no
// dia (marcação individual sobre a chamada, que continua valendo na frequência), o texto
// diz isso e details.afterPrevails = false. Não grava no banco (db.save() depois, em
// quem chama).
function recordAttendanceAudit(memory, { req, actor, action, studentEmail, courseId, studentClass, date, before = [], after = null, timestamp } = {}) {
    const previous = (Array.isArray(before) ? before : []).filter(r => r && typeof r === 'object');
    const prevails = !after || effectiveDayRecord(previous.concat([after])) === after;
    const details = {
        date,
        before: previous.map(attendanceSnapshot),
        after: attendanceSnapshot(after),
    };
    if (!prevails) details.afterPrevails = false;
    return recordAudit(memory, {
        req,
        actor,
        action,
        category: 'attendance',
        studentEmail,
        courseId: courseId || '',
        studentClass: studentClass || '',
        field: `Presença em ${formatDateBR(date)}`,
        oldValue: describe(effectiveDayRecord(previous)),
        newValue: prevails ? describe(after) : `${describe(after)}, mas a chamada do dia continua valendo`,
        details,
    }, { timestamp });
}

// Data local (AAAA-MM-DD) de uma hora (ms ou ISO) no fuso das configurações.
function localDateOf(value, timezone) {
    const time = validTime(value);
    if (!time) return null;
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
    } catch (e) {
        return new Date(time).toISOString().slice(0, 10);
    }
}

// Aluno com cadastro encerrado (Inativo, Concluído, Transferido, Evadido) fica fora da
// chamada das datas novas. Aparece numa data só se já tem registro nela ou, quando a
// mudança de situação tem hora gravada (statusChangedAt, do Desligar aluno), se a data é
// anterior ao dia da mudança: a chamada atrasada de quando ele ainda estava na turma.
function closedStudentListedOn({ hasRecord = false, date, statusChangedAt, timezone } = {}) {
    if (hasRecord) return true;
    const changedOn = localDateOf(statusChangedAt, timezone);
    return !!changedOn && YMD_RE.test(String(date || '')) && String(date) < changedOn;
}

module.exports = {
    WEEKDAYS, HHMM_RE, AULA_STATUS, JUST_TIPOS,
    configDefault, sanitizeDisciplinas, sanitizeGradeTemplates, sanitizeAttendanceConfig,
    effectiveAttendanceConfig, weekdayOf, gradeForDate,
    hhmmToMin, deriveAulasFromArrival, aulaCountsAsFalta, recordAulas,
    classDayWindow, withinClassDayWindow,
    sanitizeAulas, sanitizeJustificativa, recordHasPresence, computeAttendanceStats,
    dedupeByDate,
    ATTENDANCE_EDIT_SESSION_MS, attendanceSnapshot, statusKey, describe, effectiveDayRecord,
    shouldAuditAttendanceChange, attendanceBaseVersion, attendanceBaseVersionFields,
    attendanceCarryOver, formatDateBR, recordAttendanceAudit,
    localDateOf, closedStudentListedOn,
};
