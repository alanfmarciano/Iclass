// Biblioteca do aluno: o que uma turma (curso + turma) vê. A listagem
// (/api/student/library) e o download do arquivo (/uploads/<arquivo>, sendControlledFile)
// usam esta mesma regra. Antes o download só conferia o curso do item: um arquivo
// restrito a uma turma (escopo 'class') ou oculto para ela saía para o aluno de outra
// turma do mesmo curso que tivesse o link.
//
// - item do curso (sem turma): vale para todas as turmas, salvo se oculto ou se a
//   turma tem a própria versão dele (item da turma com sourceLibraryId);
// - item da turma: só para essa turma, salvo se oculto (marcador lib_hidden_*).
function visibleLibraryEntries(library, courseId, studentClass) {
    const cid = String(courseId || '').trim();
    const className = String(studentClass || '').trim();
    const courseEntries = (library || []).filter(entry => entry && String(entry.courseId || '') === cid);
    const classEntries = courseEntries.filter(entry => String(entry.studentClass || '') === className);
    const replaced = new Set(classEntries.map(entry => entry.sourceLibraryId).filter(Boolean));
    return [
        ...courseEntries.filter(entry => !entry.studentClass && !entry.hidden && !replaced.has(entry.id)),
        ...classEntries.filter(entry => !entry.hidden),
    ];
}

// O arquivo é de algum item visível numa turma em que o aluno tem matrícula aprovada?
// `belongsToClass(student, cls)` é a regra de matrícula de middlewares.js.
function studentCanDownloadLibraryFile({ student, filename, library, classes, belongsToClass }) {
    if (!student || !filename || typeof belongsToClass !== 'function') return false;
    return (classes || []).some(cls => cls && cls.name
        && belongsToClass(student, cls)
        && visibleLibraryEntries(library, cls.courseId, cls.name).some(entry => entry.filename === filename));
}

module.exports = { visibleLibraryEntries, studentCanDownloadLibraryFile };
