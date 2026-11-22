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
// mudou."). Outros grupos (revisão respondida, correção concluída) acrescentam o tipo
// deles em NOTICE_TEXTS.
const studentFeeds = require('./studentFeeds.js');
const { examTitle, scopeSubmissionsToContext } = require('./gradebook.js');
const { normalizeScore } = require('./submissionAttempts.js');

const PROVIDER_ID = 'nota-alterada';

const NOTICE_TEXTS = {
    gabarito_corrigido: notice => (Number(notice.numeroNaProva) > 0
        ? `O gabarito da questão ${Number(notice.numeroNaProva)} foi corrigido e a sua nota mudou.`
        : 'O gabarito da prova foi corrigido e a sua nota mudou.'),
};

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
        && String(submission.student?.email || '').trim().toLowerCase() === email
        && Array.isArray(submission.scoreHistory)
        && submission.scoreHistory.some(entry => entry && entry.avisoAluno));
    if (!own.length) return [];
    // O mesmo recorte de contexto do item "Nota publicada" (e da tela Notas).
    const scoped = scopeSubmissionsToContext(own, { courseId, studentClass, students: memory.students || [], classes: memory.classes || [] });
    const items = [];
    scoped.forEach(submission => {
        const title = examTitle(submission.examKey, { evaluations: memory.evaluations || {} });
        const label = String(title || 'Prova').replace(/^Avaliacao_/, '').replace(/_/g, ' ');
        submission.scoreHistory.forEach((entry, index) => {
            const notice = entry && entry.avisoAluno;
            const text = notice && NOTICE_TEXTS[notice.tipo] ? NOTICE_TEXTS[notice.tipo](notice) : '';
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
    NOTICE_TEXTS,
    PROVIDER_ID,
    markGradeChangeNotice,
    noticeItems,
};
