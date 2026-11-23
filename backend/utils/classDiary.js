// Diário de classe: o conteúdo de cada aula da turma (fase 3, B11 / P4-S7, FUN-09; D3, D4
// e D5 do P4).
//
// Uma coleção só, memory.classDiary (tabela class_diary, missing 'keep' no registro), com
// um documento por curso + turma + data:
//   { id: 'dia_<ms>_<6 hex>', schemaVersion: 1, courseId, studentClass, date: 'AAAA-MM-DD',
//     aulas: [{ ordem: 1..12, disciplinaId, conteudo (até 2000), atividade (até 1000),
//               observacao (até 1000) }],
//     registradoPor, registradoEm (ms), atualizadoPor, atualizadoEm (ms),
//     versao (sobe a cada gravação que muda alguma coisa),
//     referenciaAuditoria: { por, em } (o começo da edição em curso, ver abaixo) }
//
// Regras:
// - O conteúdo é da aula da turma, não do aluno: não vai para o registro de presença
//   (attendance tem uma linha por aluno, regravada a cada autosave da chamada), nem para
//   Meus dados, e a anonimização não mexe. registradoPor e atualizadoPor são e-mails da
//   equipe, como a autoria dos avisos.
// - Gravar é sempre juntar (mergeDiaryLessons): as aulas que o pedido não traz ficam como
//   estão, e o campo que não vem numa aula (undefined) fica com o valor gravado. Assim uma
//   tela antiga, ou que mostra só parte das aulas, nunca apaga o que não mandou. Para
//   limpar, manda-se o texto vazio.
// - Aula sem conteúdo nenhum (conteúdo, atividade e observação vazios) não é guardada; o
//   documento do dia nunca é apagado pela tela (guarda legal): esvaziado, fica com
//   aulas [] e a versão sobe. Turma excluída mantém o diário.
// - A aula escrita precisa estar na grade da semana da turma naquela data
//   (academicCalendar.weeklyLessons, a mesma grade da chamada feita "mesmo assim") ou já
//   ter conteúdo gravado (a grade mudou depois); a disciplina vem da grade, depois do que
//   já estava gravado e só então do pedido.
// - Pedido que não muda nada não grava nem sobe a versão (o autosave da tela regrava o
//   mesmo texto).
// - Auditoria (D4): a primeira gravação do dia vira diary_saved; depois, a mudança feita
//   por outra pessoa ou mais de 24 h depois do começo da edição em curso
//   (referenciaAuditoria) vira diary_changed, com antes e depois só das aulas que mudaram,
//   e passa a ser a referência nova. O autosave do mesmo autor dentro das 24 h não gera
//   entrada (a mesma ideia de attendanceUtil.shouldAuditAttendanceChange).
//
// Este arquivo não carrega database.js nem settings.js: memória, turma, curso e hora vêm
// de quem chama (a rota em backend/routes/adminDiary.js).
const crypto = require('crypto');
const academicCalendar = require('./academicCalendar.js');

const DIARY_SCHEMA_VERSION = 1;
const DIARY_LIMITS = Object.freeze({
    maxOrdem: 12,
    maxAulas: 12,
    conteudoMax: 2000,
    atividadeMax: 1000,
    observacaoMax: 1000,
    disciplinaMax: 60,
});
// Mesmo autor dentro deste tempo, desde o começo da edição: autosave, sem entrada nova.
const DIARY_EDIT_SESSION_MS = 24 * 60 * 60 * 1000;
const DIARY_ID_PATTERN = /^dia_\d+_[0-9a-f]{6}$/;
const TEXT_FIELDS = Object.freeze(['conteudo', 'atividade', 'observacao']);
const FIELD_MAX = Object.freeze({
    conteudo: DIARY_LIMITS.conteudoMax,
    atividade: DIARY_LIMITS.atividadeMax,
    observacao: DIARY_LIMITS.observacaoMax,
});

const text = value => (value === undefined || value === null ? '' : String(value)).trim();
const lower = value => text(value).toLowerCase();

function newDiaryId(now = Date.now()) {
    return `dia_${now}_${crypto.randomBytes(3).toString('hex')}`;
}

function validOrdem(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 && number <= DIARY_LIMITS.maxOrdem ? number : null;
}

function validTime(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

// Uma aula gravada, lida com tolerância (linha editada à mão, versão futura): ordem
// inválida some; texto que não é texto vira vazio; texto acima do limite é cortado.
function normalizeLesson(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ordem = validOrdem(raw.ordem);
    if (!ordem) return null;
    const lesson = { ordem, disciplinaId: text(raw.disciplinaId).slice(0, DIARY_LIMITS.disciplinaMax) };
    TEXT_FIELDS.forEach(field => {
        lesson[field] = typeof raw[field] === 'string' ? raw[field].trim().slice(0, FIELD_MAX[field]) : '';
    });
    return lesson;
}

const hasContent = lesson => !!lesson && TEXT_FIELDS.some(field => lesson[field]);

// As aulas gravadas de um documento: válidas, com conteúdo, uma por ordem (repetida: vale
// a primeira) e em ordem.
function storedLessons(record) {
    const seen = new Set();
    const out = [];
    (record && Array.isArray(record.aulas) ? record.aulas : []).forEach(raw => {
        const lesson = normalizeLesson(raw);
        if (!lesson || seen.has(lesson.ordem) || !hasContent(lesson)) return;
        seen.add(lesson.ordem);
        out.push(lesson);
    });
    return out.sort((a, b) => a.ordem - b.ordem);
}

// Versão gravada: a do documento (0 para o registro sem versão, de outra versão ou
// editado à mão); null quando o dia ainda não tem documento.
function diaryVersion(record) {
    if (!record) return null;
    const number = Number(record.versao);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function sameClass(record, courseId, studentClass) {
    return !!record && typeof record === 'object'
        && text(record.courseId) === text(courseId)
        && text(record.studentClass) === text(studentClass);
}

// O documento do dia da turma. Mais de um (backup com chave composta repetida, que a
// restauração só avisa): vale o de versão mais alta e, empatado, o mais recente.
function findDiary(memory, { courseId, studentClass, date }) {
    const list = memory && Array.isArray(memory.classDiary) ? memory.classDiary : [];
    let found = null;
    list.forEach(record => {
        if (!sameClass(record, courseId, studentClass) || text(record.date) !== text(date)) return;
        if (!found) { found = record; return; }
        const a = diaryVersion(record);
        const b = diaryVersion(found);
        if (a > b || (a === b && (validTime(record.atualizadoEm) || 0) > (validTime(found.atualizadoEm) || 0))) found = record;
    });
    return found;
}

// A grade da semana da turma na data, com o nome da disciplina do curso.
function gradeLessons(cls, course, date) {
    const names = new Map(((course && Array.isArray(course.disciplinas)) ? course.disciplinas : [])
        .filter(item => item && item.id !== undefined).map(item => [String(item.id), text(item.nome)]));
    const seen = new Set();
    const out = [];
    academicCalendar.weeklyLessons(cls, date).forEach(raw => {
        const ordem = validOrdem(raw && raw.ordem);
        if (!ordem || seen.has(ordem)) return;
        seen.add(ordem);
        const disciplinaId = text(raw.disciplinaId);
        out.push({ ordem, inicio: text(raw.inicio), disciplinaId, disciplinaNome: names.get(disciplinaId) || '' });
    });
    return out.sort((a, b) => a.ordem - b.ordem);
}

// O diário do dia para a tela: uma aula por aula da grade da semana (vazia quando não há
// conteúdo) e as aulas gravadas que saíram da grade (naGrade: false), em ordem; com a
// versão (null sem documento), quem registrou e quem alterou por último, e o porquê de
// não haver aula no calendário (naoLetivo, foraDoPeriodo), como a chamada.
function diaryDayView(memory, { cls, course, date }) {
    const record = cls ? findDiary(memory, { courseId: cls.courseId, studentClass: cls.name, date }) : null;
    const stored = new Map(storedLessons(record).map(lesson => [lesson.ordem, lesson]));
    const grade = cls ? gradeLessons(cls, course, date) : [];
    const names = new Map(((course && Array.isArray(course.disciplinas)) ? course.disciplinas : [])
        .filter(item => item && item.id !== undefined).map(item => [String(item.id), text(item.nome)]));
    const aulas = grade.map(lesson => {
        const saved = stored.get(lesson.ordem);
        return {
            ...lesson,
            naGrade: true,
            conteudo: saved ? saved.conteudo : '',
            atividade: saved ? saved.atividade : '',
            observacao: saved ? saved.observacao : '',
        };
    });
    stored.forEach(saved => {
        if (grade.some(lesson => lesson.ordem === saved.ordem)) return;
        aulas.push({
            ordem: saved.ordem,
            inicio: '',
            disciplinaId: saved.disciplinaId,
            disciplinaNome: names.get(saved.disciplinaId) || '',
            naGrade: false,
            conteudo: saved.conteudo,
            atividade: saved.atividade,
            observacao: saved.observacao,
        });
    });
    aulas.sort((a, b) => a.ordem - b.ordem);
    const day = cls ? academicCalendar.dayStatus(memory, cls, date) : { naoLetivo: null, foraDoPeriodo: false };
    return {
        courseId: cls ? String(cls.courseId || '') : '',
        studentClass: cls ? String(cls.name || '') : '',
        date,
        versao: diaryVersion(record),
        registradoPor: record ? (text(record.registradoPor) || null) : null,
        registradoEm: record ? validTime(record.registradoEm) : null,
        atualizadoPor: record ? (text(record.atualizadoPor) || text(record.registradoPor) || null) : null,
        atualizadoEm: record ? (validTime(record.atualizadoEm) || validTime(record.registradoEm)) : null,
        encerrada: !!(cls && academicCalendar.isClassClosed(cls)),
        naoLetivo: day.naoLetivo || null,
        foraDoPeriodo: !!day.foraDoPeriodo,
        aulas,
    };
}

function fail(status, error, extra = {}) {
    return { ok: false, status, error, ...extra };
}

// Junta as aulas do pedido (já conferidas pelo schema da rota: ordem 1..12, textos dentro
// do limite) com as gravadas. Devolve { ok, aulas } (as que ficam, só com conteúdo, em
// ordem) ou { ok: false, status: 400, error, field }.
function mergeDiaryLessons(memory, { cls, course, date, record, input }) {
    const grade = new Map(gradeLessons(cls, course, date).map(lesson => [lesson.ordem, lesson]));
    const current = new Map(storedLessons(record).map(lesson => [lesson.ordem, lesson]));
    const seen = new Set();
    const list = Array.isArray(input) ? input : [];
    for (let index = 0; index < list.length; index++) {
        const raw = list[index] && typeof list[index] === 'object' ? list[index] : {};
        const ordem = validOrdem(raw.ordem);
        const field = `aulas[${index}].ordem`;
        if (!ordem) return fail(400, `A aula ${index + 1} da lista está sem número (de 1 a ${DIARY_LIMITS.maxOrdem}).`, { field });
        if (seen.has(ordem)) return fail(400, `A ${ordem}ª aula aparece duas vezes no pedido.`, { field });
        seen.add(ordem);
        const saved = current.get(ordem);
        const fromGrade = grade.get(ordem);
        if (!fromGrade && !saved) {
            // Aula fora da grade, sem nada gravado: só se o pedido não escreve nada nela.
            if (TEXT_FIELDS.some(name => typeof raw[name] === 'string' && raw[name].trim())) {
                return fail(400, `A ${ordem}ª aula não está na grade da turma neste dia.`, { field, code: 'lesson_not_in_grade' });
            }
            continue;
        }
        const next = {
            ordem,
            disciplinaId: fromGrade ? fromGrade.disciplinaId : (saved ? saved.disciplinaId : text(raw.disciplinaId).slice(0, DIARY_LIMITS.disciplinaMax)),
        };
        TEXT_FIELDS.forEach(name => {
            next[name] = raw[name] === undefined || raw[name] === null
                ? (saved ? saved[name] : '')
                : String(raw[name]).trim().slice(0, FIELD_MAX[name]);
        });
        if (hasContent(next)) current.set(ordem, next);
        else current.delete(ordem);
    }
    return { ok: true, aulas: [...current.values()].sort((a, b) => a.ordem - b.ordem) };
}

const lessonKey = lesson => JSON.stringify([lesson.ordem, lesson.disciplinaId, lesson.conteudo, lesson.atividade, lesson.observacao]);

// As aulas que mudaram entre duas listas: { ordens, antes, depois } (antes e depois só
// delas; a aula que não existia, ou que saiu, aparece só de um lado).
function changedLessons(before, after) {
    const a = new Map(before.map(lesson => [lesson.ordem, lesson]));
    const b = new Map(after.map(lesson => [lesson.ordem, lesson]));
    const ordens = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)
        .filter(ordem => !a.has(ordem) || !b.has(ordem) || lessonKey(a.get(ordem)) !== lessonKey(b.get(ordem)));
    return {
        ordens,
        antes: ordens.filter(ordem => a.has(ordem)).map(ordem => ({ ...a.get(ordem) })),
        depois: ordens.filter(ordem => b.has(ordem)).map(ordem => ({ ...b.get(ordem) })),
    };
}

// Começo da edição em curso: a referência gravada ou, no documento sem ela, a última
// alteração (ou o registro).
function auditReference(record) {
    const ref = record && record.referenciaAuditoria && typeof record.referenciaAuditoria === 'object' ? record.referenciaAuditoria : null;
    if (ref && validTime(ref.em)) return { por: lower(ref.por), em: validTime(ref.em) };
    return {
        por: lower(record && (record.atualizadoPor || record.registradoPor)),
        em: validTime(record && record.atualizadoEm) || validTime(record && record.registradoEm),
    };
}

// A mudança vira diary_changed? Outra pessoa, ou mais de 24 h desde o começo da edição.
function shouldAuditDiaryChange(record, actorEmail, now = Date.now()) {
    const ref = auditReference(record);
    if (!ref.por || ref.por !== lower(actorEmail)) return true;
    if (!ref.em) return true;
    return Number(now) - ref.em > DIARY_EDIT_SESSION_MS;
}

// Grava o dia na memória (sem salvar no banco; a rota salva). Confere a versão antes:
// outra do que a gravada responde 409 { code: 'diary_changed' } (duas abas, duas
// pessoas). Devolve:
// - { ok: false, status, error, field?, code? } (nada mudou);
// - { ok: true, changed: false, record } (nada a gravar: mesmo conteúdo, ou dia sem
//   documento e sem conteúdo);
// - { ok: true, changed: true, record, created, audit: null | { action, ordens, antes,
//   depois } } (a rota grava a auditoria com isso, na mesma gravação).
function saveDiaryDay(memory, { cls, course, date, versao, aulas }, { actor, now = Date.now() } = {}) {
    if (!cls) return fail(404, 'Turma não encontrada.', { field: 'studentClass' });
    if (!academicCalendar.isValidDate(date)) return fail(400, 'Data inválida. Informe uma data real no formato AAAA-MM-DD.', { field: 'date' });
    const record = findDiary(memory, { courseId: cls.courseId, studentClass: cls.name, date });
    const current = diaryVersion(record);
    const sent = versao === undefined || versao === null ? null : Number(versao);
    if (sent !== current) {
        return fail(409, 'O diário deste dia foi alterado em outra aba ou por outra pessoa. Veja a versão salva antes de gravar de novo.', { code: 'diary_changed' });
    }
    const merged = mergeDiaryLessons(memory, { cls, course, date, record, input: aulas });
    if (!merged.ok) return merged;
    const before = storedLessons(record);
    const diff = changedLessons(before, merged.aulas);
    if (!diff.ordens.length) return { ok: true, changed: false, record: record || null };
    const actorEmail = lower(actor) || 'admin';
    if (!Array.isArray(memory.classDiary)) memory.classDiary = [];
    if (!record) {
        const created = {
            id: newDiaryId(now),
            schemaVersion: DIARY_SCHEMA_VERSION,
            courseId: String(cls.courseId || ''),
            studentClass: String(cls.name || ''),
            date,
            aulas: merged.aulas,
            registradoPor: actorEmail,
            registradoEm: now,
            atualizadoPor: actorEmail,
            atualizadoEm: now,
            versao: 1,
            referenciaAuditoria: { por: actorEmail, em: now },
        };
        memory.classDiary.push(created);
        return { ok: true, changed: true, created: true, record: created, audit: { action: 'diary_saved', ...diff } };
    }
    const reference = auditReference(record);
    const audited = shouldAuditDiaryChange(record, actorEmail, now);
    record.aulas = merged.aulas;
    record.atualizadoPor = actorEmail;
    record.atualizadoEm = now;
    record.versao = current + 1;
    if (record.schemaVersion === undefined) record.schemaVersion = DIARY_SCHEMA_VERSION;
    if (audited) record.referenciaAuditoria = { por: actorEmail, em: now };
    else if (!record.referenciaAuditoria) record.referenciaAuditoria = reference;
    return { ok: true, changed: true, created: false, record, audit: audited ? { action: 'diary_changed', ...diff } : null };
}

module.exports = {
    DIARY_SCHEMA_VERSION,
    DIARY_LIMITS,
    DIARY_EDIT_SESSION_MS,
    DIARY_ID_PATTERN,
    newDiaryId,
    normalizeLesson,
    storedLessons,
    diaryVersion,
    findDiary,
    gradeLessons,
    diaryDayView,
    mergeDiaryLessons,
    changedLessons,
    shouldAuditDiaryChange,
    saveDiaryDay,
};
