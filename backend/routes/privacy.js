// Rotas públicas e do aluno sobre privacidade (LGPD).
//
// H8a-1 (SEG-08, OPS-12): GET /api/legal/documents?escola=ID|courseId=ID, sem login, com
// os Termos de Uso e a Política de Privacidade atuais, já com os dados da escola nos
// marcadores. O atual é a maior versão publicada; sem publicação, é o modelo do IClass
// (isModel: true), e ninguém precisa aceitar nada. O rascunho nunca aparece aqui.
// Funciona sem internet: o texto mora no banco e o modelo, no código.
//
// H8a-2 (SEG-08, SEG-09, decisão P4): o primeiro acesso do aluno.
// GET  /api/student/privacy/status?courseId=   o que falta (aceite de documento publicado,
//      data de nascimento, responsável de menor) e os textos pendentes já preenchidos;
// POST /api/student/privacy/accept { termsDocumentId?, privacyDocumentId?, birthDate?,
//      guardian? }   grava o que faltava (utils/legalAcceptance.js), com a auditoria
//      privacy_accept e, para a data e o responsável, a alteração do cadastro.
// Política 'ciência': nada disso bloqueia o login nem as outras rotas; o portão do portal
// (StudentPrivacyGate) pede o que falta, e a prova nunca passa por ele.
//
// H8c reduzido (SEG-14, art. 18 da LGPD): GET /api/student/my-data?finalidade=imprimir
// baixa a cópia dos dados pessoais do próprio aluno (meus-dados-AAAA-MM-DD.json, versão
// 'aluno' de utils/studentDataExport.js), no máximo 5 vezes por hora. Cada cópia fica na
// auditoria (lgpd_export, com quantos registros de cada tipo saíram). A tela "Meus dados"
// mostra a mesma cópia para imprimir (web/src/lib/dataExportPrint.js).
const express = require('express');
const db = require('../database.js');
const { publicLegalDocuments } = require('../utils/legalDocuments.js');
const { validateStudentSession } = require('../middlewares.js');
const legalAcceptance = require('../utils/legalAcceptance.js');
const { recordAudit } = require('../utils/audit.js');
const { recordStudentAudit } = require('../utils/students.js');
const { buildStudentDataExport, exportFileName } = require('../utils/studentDataExport.js');
const { studentEmailOwnership } = require('../utils/gradebook.js');
const { todayIso } = require('../utils/birthDate.js');
const rateLimit = require('../utils/rateLimit.js');

// Cópias de "Meus dados" por aluno: 5 por hora (o arquivo sai inteiro a cada pedido).
const MY_DATA_LIMIT = Object.freeze({ max: 5, windowMs: 60 * 60 * 1000 });
const MY_DATA_PURPOSES = ['baixar', 'imprimir'];

const router = express.Router();

function queryText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

router.get('/api/legal/documents', (req, res) => {
    const query = req.query || {};
    res.json(publicLegalDocuments(db.memory, {
        escola: queryText(query.escola) || queryText(query.schoolId),
        courseId: queryText(query.courseId),
    }));
});

router.get('/api/student/privacy/status', validateStudentSession, (req, res) => {
    const query = req.query || {};
    res.json(legalAcceptance.studentPrivacyStatus(db.memory, req.studentAccount, { courseId: queryText(query.courseId) }));
});

router.post('/api/student/privacy/accept', validateStudentSession, async (req, res) => {
    const student = req.studentAccount;
    const body = req.body || {};
    const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
    let result;
    try {
        result = legalAcceptance.applyPrivacyAccept(db.memory, student, body, { req, courseId });
    } catch (error) {
        if (!(error instanceof legalAcceptance.PrivacyAcceptError)) throw error;
        const payload = legalAcceptance.privacyErrorBody(error);
        // Documento trocado com a tela aberta: a resposta já leva o status novo, para a
        // tela mostrar o texto atual sem outro pedido.
        if (error.status === 409) payload.status = legalAcceptance.studentPrivacyStatus(db.memory, student, { courseId });
        return res.status(error.status).json(payload);
    }
    const { accepted, changes, birthDateInformed, guardianInformed, isMinor, school } = result;
    if (accepted.length || changes.length) {
        // privacy_accept ("Termos de Uso ou Política de Privacidade aceitos") só quando o aluno
        // aceitou um documento. Só a data de nascimento ou o responsável (antes de a escola
        // publicar os textos, por exemplo) ficam apenas na alteração do cadastro abaixo:
        // a Auditoria não diz que ele aceitou o que não aceitou.
        if (accepted.length) recordAudit(db.memory, {
            req,
            actor: student.email,
            action: 'privacy_accept',
            category: 'privacy',
            studentEmail: student.email,
            details: legalAcceptance.acceptAuditDetails(accepted, {
                source: 'portal',
                schoolId: school ? school.id : null,
                birthDateInformed,
                guardianInformed,
                isMinor,
            }),
        });
        if (changes.length) {
            recordStudentAudit(db.memory, { actor: student.email, studentEmail: student.email, action: 'update', changes, req });
        }
        await db.save();
    }
    res.json({ ...legalAcceptance.studentPrivacyStatus(db.memory, student, { courseId }), saved: accepted.length + changes.length > 0 });
});

router.get('/api/student/my-data', validateStudentSession, async (req, res) => {
    const email = req.studentEmail;
    const limitKey = `student-my-data:${email}`;
    // Conta já aqui, antes de qualquer espera: conferir antes e contar depois deixava
    // pedidos ao mesmo tempo passarem do teto (todos conferiam antes do primeiro contar).
    // A cópia que não chega a ser entregue (aluno sumiu, falha ao gravar) devolve a vez.
    const allowed = rateLimit.hit(limitKey, MY_DATA_LIMIT);
    if (!allowed.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
        const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
            success: false,
            code: 'my_data_rate_limited',
            error: `Você já baixou seus dados ${MY_DATA_LIMIT.max} vezes na última hora. Tente de novo em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
            retryAfterSeconds,
        });
    }
    let delivered = false;
    try {
        const purposeText = typeof (req.query || {}).finalidade === 'string' ? req.query.finalidade.trim() : '';
        const purpose = MY_DATA_PURPOSES.includes(purposeText) ? purposeText : 'baixar';
        // As teclas da prova moram em tabela própria: buscadas antes, por todos os e-mails dele.
        const keystrokes = await db.keystrokes.findByEmails(studentEmailOwnership(db.memory, email).emails);
        const data = buildStudentDataExport(db.memory, email, { audience: 'aluno', keystrokes });
        if (!data) return res.status(404).json({ success: false, error: 'Cadastro não encontrado.' });
        recordAudit(db.memory, {
            req,
            actor: email,
            action: 'lgpd_export',
            category: 'privacy',
            studentEmail: email,
            details: { audience: 'aluno', purpose, counts: data.counts },
        });
        await db.save();
        res.set('Content-Disposition', `attachment; filename="${exportFileName('aluno', email, todayIso())}"`);
        res.json(data);
        delivered = true;
    } finally {
        if (!delivered) rateLimit.release(limitKey);
    }
});

module.exports = router;
