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
const express = require('express');
const db = require('../database.js');
const { publicLegalDocuments } = require('../utils/legalDocuments.js');
const { validateStudentSession } = require('../middlewares.js');
const legalAcceptance = require('../utils/legalAcceptance.js');
const { recordAudit } = require('../utils/audit.js');
const { recordStudentAudit } = require('../utils/students.js');

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
        recordAudit(db.memory, {
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

module.exports = router;
