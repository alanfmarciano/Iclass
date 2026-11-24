// Aviso "Nota alterada" no sino do aluno (fase 3, P3-S6: AVA-X2; provedor do sino do
// contrato studentFeeds, fundação C0b).
//
// Quando uma nota JÁ PUBLICADA muda por um ato do professor que o aluno precisa saber
// (hoje: o gabarito corrigido depois da prova), a entrada da mudança no scoreHistory da
// entrega leva avisoAluno = { tipo, numeroNaProva? }. O provedor lê essas entradas: nada
// novo vai para o banco além da marca, e a nota publicada depois da correção já aparece
// pelo item "Nota publicada" de sempre (sem aviso a mais). O texto do aviso não traz o
// motivo do professor nem o gabarito: o gabarito só chega ao aluno quando é liberado.
//
// Tipos: 'gabarito_corrigido' ("O gabarito da questão 7 foi corrigido e a sua nota
// mudou."). Outros grupos acrescentam o tipo deles em NOTICE_TEXTS.
//
// Fase 3, P3-S5 (A19): qualquer outra mudança da nota depois da publicação também avisa
// ("O professor revisou a correção e a sua nota mudou."): é a entrada do scoreHistory
// com a nota de antes diferente da de depois e a hora depois da publicação
// (gradePublishedAt), seja qual for a rota (correção do professor, resposta a um pedido de
// revisão, anulação ou troca de questão com a prova em andamento). Nada novo é gravado
// para isso: o histórico que já existia avisa também as mudanças antigas depois da
// publicação. Registro sem gradePublishedAt (anterior ao 559072a) só avisa pela marca.
// O aviso só aparece enquanto o aluno vê a nota (a mesma regra do item "Nota publicada":
// nem aguardando a correção do professor, nem anulada com 'desconsiderar').
const studentFeeds = require('./studentFeeds.js');
const { examTitle, scopeSubmissionsToContext } = require('./gradebook.js');
const { integrityDecision, isAwaitingCorrection, normalizeScore } = require('./submissionAttempts.js');

const PROVIDER_ID = 'nota-alterada';

const GENERIC_TEXT = 'O professor revisou a correção e a sua nota mudou.';

const NOTICE_TEXTS = {
    gabarito_corrigido: notice => (Number(notice.numeroNaProva) > 0
        ? `O gabarito da questão ${Number(notice.numeroNaProva)} foi corrigido e a sua nota mudou.`
        : 'O gabarito da prova foi corrigido e a sua nota mudou.'),
};

function timeOf(value) {
    const number = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(number) ? number : 0;
}

// Texto do aviso de uma entrada do histórico da nota, ou '' quando ela não avisa.
function noticeText(entry, publishedAt) {
    if (!entry || typeof entry !== 'object') return '';
    const notice = entry.avisoAluno;
    if (notice && NOTICE_TEXTS[notice.tipo]) return NOTICE_TEXTS[notice.tipo](notice);
    const at = timeOf(entry.at);
    if (!publishedAt || !at || at <= publishedAt) return '';
    const from = normalizeScore(entry.from);
    const to = normalizeScore(entry.to);
    return to !== null && from !== to ? GENERIC_TEXT : '';
}

function visibleGrade(submission) {
    const decision = integrityDecision(submission);
    if (decision === 'desconsiderar') return false;
    return decision === 'zero' || !isAwaitingCorrection(submission);
}

// Marca a última mudança de nota da entrega (a que a recorreção acabou de gravar) para
// avisar o aluno. Só vale para nota publicada; devolve true quando marcou.
function markGradeChangeNotice(submission, notice) {
    if (!submission || submission.gradePublished !== true) return false;
    const history = Array.isArray(submission.scoreHistory) ? submission.scoreHistory : [];
    const last = history[history.length - 1];
    if (!last || !NOTICE_TEXTS[notice?.tipo]) return false;
    last.avisoAluno = { ...notice };
    return true;
}

function noticeItems(ctx) {
    const { memory, email, courseId, studentClass, seenAt } = ctx || {};
    if (!memory || !email) return [];
    const own = (memory.submissions || []).filter(submission => submission
        && submission.gradePublished === true
        && normalizeScore(submission.score) !== null
        && visibleGrade(submission)
        && String(submission.student?.email || '').trim().toLowerCase() === email
        && Array.isArray(submission.scoreHistory)
        && submission.scoreHistory.some(entry => noticeText(entry, timeOf(submission.gradePublishedAt))));
    if (!own.length) return [];
    // O mesmo recorte de contexto do item "Nota publicada" (e da tela Notas).
    const scoped = scopeSubmissionsToContext(own, { courseId, studentClass, students: memory.students || [], classes: memory.classes || [] });
    const items = [];
    scoped.forEach(submission => {
        const title = examTitle(submission.examKey, { evaluations: memory.evaluations || {}, classes: memory.classes || [] });
        const label = String(title || 'Prova').replace(/^Avaliacao_/, '').replace(/_/g, ' ');
        const publishedAt = timeOf(submission.gradePublishedAt);
        submission.scoreHistory.forEach((entry, index) => {
            const text = noticeText(entry, publishedAt);
            if (!text) return;
            const at = Date.parse(entry.at) || 0;
            items.push({
                id: `${PROVIDER_ID}:${submission.id}:${index}`,
                type: 'nota',
                title: 'Nota alterada',
                text: `${label}: ${text}`,
                at,
                href: '/aluno/provas',
                unread: at > Number(seenAt || 0),
            });
        });
    });
    return items;
}

studentFeeds.registerStudentNotificationProvider({ id: PROVIDER_ID, items: noticeItems });

module.exports = {
    GENERIC_TEXT,
    NOTICE_TEXTS,
    PROVIDER_ID,
    markGradeChangeNotice,
    noticeItems,
    noticeText,
};
