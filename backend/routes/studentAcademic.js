// Portal do aluno: parte acadêmica da fase 3 (grupo P2 e, depois, P4-S13). Rotas novas do
// aluno não entram em student.js (order_notes do plano); este router entra no createApp
// antes de studentRoutes (ordem_no_createApp).
//
// - GET /api/student/calendar.ics?courseId=&studentClass= (B3 / P2-S5, FUN-15): a agenda
//   da turma em .ics, com o que o aluno vê no calendário (eventos do curso e da turma e os
//   dos provedores, como os dias não letivos), para importar no celular. Exige a sessão
//   do aluno e a matrícula na turma, como /api/student/calendar-events. Só lê: entra na
//   lista da pré-visualização (PREVIEW_READ_ROUTES).
// As próximas subetapas acrescentam aqui o resumo de notas (grades-summary, P2-S3) e o
// autoatendimento (P4-S13).
const express = require('express');
const db = require('../database.js');
const { validateStudentSession, studentBelongsToClass, findClassByNameAndCourse } = require('../middlewares.js');
const settingsUtil = require('../utils/settings.js');
const { studentCalendarEvents } = require('../utils/calendarFeed.js');
const { buildIcs, icsFileName, calendarEventToIcs } = require('../utils/icsCalendar.js');

const router = express.Router();

router.get('/api/student/calendar.ics', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    // O aluno vem da sessão (req.studentAccount, contrato X2): é o aluno real ou o aluno
    // virtual da pré-visualização, que não está em students (junção J1, C2 + B3).
    const student = req.studentAccount;
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!student || !cls || !studentBelongsToClass(student, cls)) {
        return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    }
    const eventos = studentCalendarEvents(db.memory, { student, email, cls, courseId, studentClass })
        .map(calendarEventToIcs)
        .filter(Boolean);
    const course = (db.memory.courses || []).find(item => item && String(item.id) === courseId);
    const nome = [(course && course.name) || courseId, studentClass].filter(Boolean).join(' · ');
    const ics = buildIcs({ nome, eventos, timezone: settingsUtil.getSettings().timezone });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${icsFileName(courseId, studentClass)}"`);
    res.send(ics);
});

module.exports = router;
