// Perfil do aluno que vai para o navegador no login (H5b; SEG-10, SEG-16).
//
// O login do aluno devolvia o cadastro inteiro (responsável, telefones, acessibilidade,
// unidade, datas de acesso...), e o portal guardava tudo em localStorage
// ('iclass-v3-auth'): num computador de laboratório compartilhado, ou com um script
// injetado, esses dados ficavam à vista. O portal só usa estes campos: nome e nome
// social, e-mail, situação, matrícula (Minha conta), turmas, cursos, pedidos de
// matrícula e a troca de senha pedida. Os outros dados continuam no servidor e nas telas
// do professor.
//
// A tela faz o mesmo com o que já estava guardado (web/src/lib/studentProfile.js): o
// perfil antigo do navegador é reduzido a estes campos ao abrir o portal.

const STUDENT_SESSION_PROFILE_FIELDS = Object.freeze([
    'email',
    'name',
    'nomeSocial',
    'status',
    'matricula',
    'studentClass',
    'period',
    'classes',
    'courses',
    'courseId',
    'currentCourseId',
    'enrollmentRequests',
    'mustChangePassword',
    'passwordChangeReason',
]);

function studentSessionProfile(student) {
    const profile = {};
    if (!student || typeof student !== 'object') return profile;
    STUDENT_SESSION_PROFILE_FIELDS.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(student, field) && student[field] !== undefined) profile[field] = student[field];
    });
    return profile;
}

module.exports = { STUDENT_SESSION_PROFILE_FIELDS, studentSessionProfile };
