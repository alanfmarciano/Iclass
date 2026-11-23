// Portal do aluno: comunicação e turma da fase 3 (grupo P5). Rotas novas do aluno não
// entram em student.js (order_notes do plano); este router entra no createApp depois de
// studentAcademic e antes de studentRoutes (ordem_no_createApp). As conversas (P5-S7a) e o
// caderno (P5-S3) entram aqui depois.
//
// - GET /api/student/groups?courseId=&studentClass= (P5-S4, CRIT-11): os grupos ativos do
//   aluno na turma, com o nome dos colegas que ainda estão nela (P-C3: só o nome, sem
//   e-mail nem telefone). Exige a sessão do aluno e a matrícula na turma. Só lê: entra na
//   lista da pré-visualização (PREVIEW_READ_ROUTES); na prévia aberta com um grupo, a
//   resposta é a de um membro desse grupo (o aluno virtual não está em nenhum).
const express = require('express');
const db = require('../database.js');
const { validateStudentSession, studentBelongsToClass, findClassByNameAndCourse } = require('../middlewares.js');
const groupRules = require('../utils/classGroups.js');

const router = express.Router();

router.get('/api/student/groups', validateStudentSession, (req, res) => {
    const courseId = String((req.query && req.query.courseId) || '').trim();
    const studentClass = String((req.query && req.query.studentClass) || '').trim();
    // O aluno vem da sessão (req.studentAccount, contrato X2): o real ou o virtual da prévia.
    const student = req.studentAccount;
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!student || !cls || !studentBelongsToClass(student, cls)) {
        return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    }
    let groups;
    if (req.preview) {
        const previewGroupId = student.previewGroupId || null;
        groups = previewGroupId
            ? groupRules.activeGroupsForClass(db.memory, cls).filter(group => String(group.id) === String(previewGroupId))
            : [];
    }
    res.set('Cache-Control', 'no-store');
    return res.json(groupRules.studentGroupsView(db.memory, cls, req.studentEmail, { groups }));
});

module.exports = router;
