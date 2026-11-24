// Pedido de revisão da nota pelo aluno (fase 3, P3-S5 / A19: AVA-07; D13 do desenho do
// P3, P-B2 com o padrão "sim, até 7 dias depois da publicação, um aberto por prova").
//
// O pedido fica na própria entrega, em submission.pedidosRevisao[] (modelo_de_dados do
// P3; nenhuma coleção nova):
//   { id 'rev_<ms>_<6 hex>', questionNumber (número da questão como o aluno vê na revisão,
//     ou null para a prova toda), texto (até 1 000), criadoEm (ms), situacao 'aberto' |
//     'respondido', resposta (até 2 000), notaMudou (bool), respondidoPor, respondidoEm (ms) }
//
// Regras (D13):
// - só com a nota publicada e visível ao aluno (nem aguardando a correção do professor,
//   nem anulada com 'desconsiderar'), em tentativa que conta (não arquivada);
// - até 7 dias depois da publicação (gradePublishedAt; registro antigo sem a data usa a
//   hora da entrega, que é anterior: o prazo nunca fica maior do que o certo);
// - um pedido aberto por vez em cada entrega, e no máximo MAX_REQUESTS_PER_SUBMISSION
//   pedidos na mesma entrega (o aluno pode pedir de novo depois da resposta, dentro do
//   prazo, mas não sem fim);
// - o professor responde na tela Corrigir; a mudança de nota, quando há, vem antes pela
//   rota da correção. notaMudou é calculado aqui pelo histórico da nota (scoreHistory com
//   mudança depois do pedido), não pelo que a tela diz.
// - o aluno vê os pedidos dele (texto, situação, resposta e se a nota mudou), nunca quem
//   respondeu (a conta do professor); o sino avisa a resposta (provedor 'revisao-respondida').
// - anonimizar o aluno apaga o texto do pedido (é texto dele) e tira nome, e-mail e
//   matrícula da resposta do professor (anonymizeReviewRequests).
const crypto = require('crypto');
const studentFeeds = require('./studentFeeds.js');
const { integrityDecision, isArchived, isAwaitingCorrection, normalizeScore } = require('./submissionAttempts.js');

const REVIEW_WINDOW_DAYS = 7;
const REVIEW_WINDOW_MS = REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REVIEW_TEXT_MIN = 10;
const REVIEW_TEXT_MAX = 1000;
const REVIEW_ANSWER_MAX = 2000;
const MAX_REQUESTS_PER_SUBMISSION = 5;
const STUDENT_PROVIDER_ID = 'revisao-respondida';

const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);

function reviewRequestsOf(submission) {
    return Array.isArray(submission?.pedidosRevisao) ? submission.pedidosRevisao.filter(isPlain) : [];
}

function openReviewRequest(submission) {
    return reviewRequestsOf(submission).find(item => item.situacao === 'aberto') || null;
}

function timeOf(value) {
    const number = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

// Quando a nota saiu para o aluno (ms) ou null.
function publishedAtOf(submission) {
    return timeOf(submission?.gradePublishedAt) || timeOf(submission?.timestamp);
}

// A nota está publicada e o aluno a vê (a mesma regra de sanitizeSubmissionForStudent e do
// item "Nota publicada" do sino).
function gradeVisibleToStudent(submission) {
    if (!submission || submission.gradePublished !== true || normalizeScore(submission.score) === null) return false;
    const decision = integrityDecision(submission);
    if (decision === 'desconsiderar') return false;
    return decision === 'zero' || !isAwaitingCorrection(submission);
}

const REFUSALS = {
    not_published: 'Só dá para pedir revisão depois que a nota desta prova for publicada.',
    archived: 'Esta tentativa não conta no seu resultado: peça a revisão da tentativa que conta.',
    deadline_passed: `O prazo para pedir revisão desta prova (${REVIEW_WINDOW_DAYS} dias depois da publicação da nota) já terminou.`,
    already_open: 'Você já tem um pedido de revisão aberto nesta prova. Espere a resposta do professor.',
    limit: `Esta prova já teve ${MAX_REQUESTS_PER_SUBMISSION} pedidos de revisão. Fale com o professor.`,
};

// { podePedir, motivo (código ou null), mensagem, prazoAte (ms ou null) } da entrega.
function reviewEligibility(submission, { now = Date.now() } = {}) {
    const publishedAt = gradeVisibleToStudent(submission) ? publishedAtOf(submission) : null;
    const prazoAte = publishedAt ? publishedAt + REVIEW_WINDOW_MS : null;
    const refuse = code => ({ podePedir: false, motivo: code, mensagem: REFUSALS[code], prazoAte });
    if (!publishedAt) return refuse('not_published');
    if (isArchived(submission)) return refuse('archived');
    if (openReviewRequest(submission)) return refuse('already_open');
    if (now > prazoAte) return refuse('deadline_passed');
    if (reviewRequestsOf(submission).length >= MAX_REQUESTS_PER_SUBMISSION) return refuse('limit');
    return { podePedir: true, motivo: null, mensagem: '', prazoAte };
}

function questionNumbersOf(submission) {
    return (Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [])
        .map(answer => Number(answer?.questionNumber))
        .filter(number => Number.isInteger(number) && number > 0);
}

function newRequestId(now) {
    return `rev_${now}_${crypto.randomBytes(3).toString('hex')}`;
}

// Grava o pedido na entrega. Devolve { ok: true, request } ou { ok: false, status, body }
// (a rota responde sem mudar nada).
function addReviewRequest(submission, { questionNumber = null, texto = '', now = Date.now() } = {}) {
    const text = String(texto || '').trim();
    if (text.length < REVIEW_TEXT_MIN) {
        return { ok: false, status: 400, body: { success: false, field: 'texto', error: `Explique o pedido com pelo menos ${REVIEW_TEXT_MIN} letras.` } };
    }
    if (text.length > REVIEW_TEXT_MAX) {
        return { ok: false, status: 400, body: { success: false, field: 'texto', error: `O pedido aceita no máximo ${REVIEW_TEXT_MAX.toLocaleString('pt-BR')} caracteres.` } };
    }
    let number = null;
    if (questionNumber !== null && questionNumber !== undefined && questionNumber !== '') {
        number = Number(questionNumber);
        if (!questionNumbersOf(submission).includes(number)) {
            return { ok: false, status: 400, body: { success: false, field: 'questionNumber', error: 'Esta questão não é da sua prova.' } };
        }
    }
    const eligibility = reviewEligibility(submission, { now });
    if (!eligibility.podePedir) {
        return { ok: false, status: 409, body: { success: false, code: `review_${eligibility.motivo}`, error: eligibility.mensagem } };
    }
    const request = {
        id: newRequestId(now),
        questionNumber: number,
        texto: text,
        criadoEm: now,
        situacao: 'aberto',
        resposta: '',
        notaMudou: false,
        respondidoPor: null,
        respondidoEm: null,
    };
    if (!Array.isArray(submission.pedidosRevisao)) submission.pedidosRevisao = [];
    submission.pedidosRevisao.push(request);
    return { ok: true, request };
}

// A nota mudou depois do pedido? Pelo histórico da nota (cada recorreção que mudou a nota
// grava uma entrada com a hora, examGrading.regradeSubmission).
function gradeChangedSince(submission, since) {
    const from = Number(since) || 0;
    return (Array.isArray(submission?.scoreHistory) ? submission.scoreHistory : []).some(entry => {
        if (!isPlain(entry)) return false;
        const at = timeOf(entry.at);
        return at !== null && at >= from && normalizeScore(entry.from) !== normalizeScore(entry.to);
    });
}

// Responde o pedido aberto. Devolve { ok: true, request } ou { ok: false, status, body }.
function answerReviewRequest(submission, requestId, { resposta = '', by = '', now = Date.now() } = {}) {
    const request = reviewRequestsOf(submission).find(item => String(item.id) === String(requestId));
    if (!request) return { ok: false, status: 404, body: { success: false, error: 'Pedido de revisão não encontrado nesta entrega.' } };
    if (request.situacao !== 'aberto') {
        return { ok: false, status: 409, body: { success: false, code: 'review_already_answered', error: 'Este pedido de revisão já foi respondido.' } };
    }
    const text = String(resposta || '').trim();
    if (!text) return { ok: false, status: 400, body: { success: false, field: 'resposta', error: 'Escreva a resposta para o aluno.' } };
    if (text.length > REVIEW_ANSWER_MAX) {
        return { ok: false, status: 400, body: { success: false, field: 'resposta', error: `A resposta aceita no máximo ${REVIEW_ANSWER_MAX.toLocaleString('pt-BR')} caracteres.` } };
    }
    request.situacao = 'respondido';
    request.resposta = text;
    request.notaMudou = gradeChangedSince(submission, request.criadoEm);
    request.respondidoPor = String(by || 'Administrador');
    request.respondidoEm = now;
    return { ok: true, request };
}

// O que o aluno vê dos pedidos dele: sem quem respondeu.
function reviewRequestsForStudent(submission) {
    return reviewRequestsOf(submission).map(item => ({
        id: String(item.id || ''),
        questionNumber: Number.isInteger(Number(item.questionNumber)) && item.questionNumber !== null ? Number(item.questionNumber) : null,
        texto: typeof item.texto === 'string' ? item.texto : '',
        criadoEm: timeOf(item.criadoEm),
        situacao: item.situacao === 'respondido' ? 'respondido' : 'aberto',
        resposta: item.situacao === 'respondido' && typeof item.resposta === 'string' ? item.resposta : '',
        notaMudou: item.situacao === 'respondido' && item.notaMudou === true,
        respondidoEm: item.situacao === 'respondido' ? timeOf(item.respondidoEm) : null,
    }));
}

// O que o professor vê (a tela Corrigir): tudo.
function reviewRequestsForTeacher(submission) {
    return reviewRequestsOf(submission).map(item => ({
        ...reviewRequestsForStudent({ pedidosRevisao: [item] })[0],
        respondidoPor: item.situacao === 'respondido' ? (item.respondidoPor || null) : null,
        ...(item.studentAnonymized === true ? { studentAnonymized: true } : {}),
    }));
}

// Anonimização (contrato C7 do P3): o texto do pedido é do aluno e sai; a resposta do
// professor fica sem o nome, o e-mail e a matrícula dele (scrub). Devolve a lista nova.
function anonymizeReviewRequests(list, scrub = null) {
    if (!Array.isArray(list)) return list;
    return list.map(item => {
        if (!isPlain(item)) return item;
        const out = { ...item, texto: '', studentAnonymized: true };
        if (typeof item.resposta === 'string' && item.resposta && typeof scrub === 'function') out.resposta = scrub(item.resposta);
        return out;
    });
}

// ------------------------------------------------------------- sino do aluno
// "Seu pedido de revisão foi respondido": um item por pedido respondido das entregas do
// aluno no contexto da turma (o mesmo recorte da tela Provas). O texto não traz a
// resposta (ela pode ser longa): o aluno lê em Provas.
function studentNoticeItems(ctx) {
    const { memory, email, courseId, studentClass, seenAt } = ctx || {};
    if (!memory || !email) return [];
    const own = (memory.submissions || []).filter(submission => submission
        && String(submission.student?.email || '').trim().toLowerCase() === email
        && reviewRequestsOf(submission).some(item => item.situacao === 'respondido'));
    if (!own.length) return [];
    // gradebook.js é lido aqui (e não no topo) para o módulo poder ser usado por quem o
    // gradebook usa, sem ciclo.
    const { examTitle, scopeSubmissionsToContext } = require('./gradebook.js');
    const scoped = scopeSubmissionsToContext(own, { courseId, studentClass, students: memory.students || [], classes: memory.classes || [] });
    const items = [];
    scoped.forEach(submission => {
        const title = examTitle(submission.examKey, { evaluations: memory.evaluations || {}, classes: memory.classes || [] });
        const label = String(title || 'Prova').replace(/^Avaliacao_/, '').replace(/_/g, ' ');
        reviewRequestsOf(submission).filter(item => item.situacao === 'respondido').forEach(item => {
            const at = timeOf(item.respondidoEm) || 0;
            items.push({
                id: `${STUDENT_PROVIDER_ID}:${submission.id}:${item.id}`,
                type: 'nota',
                title: 'Seu pedido de revisão foi respondido',
                text: `${label}: ${item.notaMudou === true ? 'a sua nota mudou' : 'a nota foi mantida'}. Veja a resposta do professor.`,
                at,
                href: `/aluno/provas?entrega=${encodeURIComponent(String(submission.id))}`,
                unread: at > Number(seenAt || 0),
            });
        });
    });
    return items;
}

studentFeeds.registerStudentNotificationProvider({ id: STUDENT_PROVIDER_ID, items: studentNoticeItems });

module.exports = {
    MAX_REQUESTS_PER_SUBMISSION,
    REVIEW_ANSWER_MAX,
    REVIEW_TEXT_MAX,
    REVIEW_TEXT_MIN,
    REVIEW_WINDOW_DAYS,
    REVIEW_WINDOW_MS,
    STUDENT_PROVIDER_ID,
    addReviewRequest,
    anonymizeReviewRequests,
    answerReviewRequest,
    gradeChangedSince,
    gradeVisibleToStudent,
    openReviewRequest,
    publishedAtOf,
    reviewEligibility,
    reviewRequestsForStudent,
    reviewRequestsForTeacher,
    reviewRequestsOf,
    studentNoticeItems,
};
