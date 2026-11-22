// ---------------------------------------------------------------------------
// Grupos de alunos da turma (fase 3, P5, CRIT-11; contrato "classGroups" do plano e C2
// do P5): grupos só são lidos por aqui.
//
// Formato da linha (modelo_de_dados.classGroups do P5):
// { id: 'grp_<ms>_<6 hex>', schemaVersion: 1, courseId, studentClass, nome, conjunto,
//   tipo: 'equipe' | 'subturma', membros: [{ email, studentId, adicionadoEm, adicionadoPor }],
//   sorteio?, criadoEm, criadoPor, atualizadoEm, atualizadoPor, arquivadoEm: ms | null,
//   arquivadoPor }.
//
// Nesta versão só existem os leitores que a pré-visualização usa (P5-S6a, C2 da trilha C):
// findGroup e activeGroupsForClass. Criar, validar, sortear, groupsOfStudent,
// groupMemberEmails e as rotas entram no P5-S4 (C12), neste mesmo arquivo. A coleção nasce
// vazia (registro classGroups, missing 'keep'), então até lá nenhum grupo existe.
// Leitura tolerante: campo ausente vale o padrão, sem reescrever a linha.
// ---------------------------------------------------------------------------

function groupList(memory) {
    return Array.isArray(memory && memory.classGroups) ? memory.classGroups.filter(group => group && typeof group === 'object') : [];
}

// Grupo arquivado: arquivadoEm preenchido (qualquer valor que não seja null, 0 ou vazio).
// Falha fechada: um valor estranho conta como arquivado.
function isGroupArchived(group) {
    if (!group || typeof group !== 'object') return true;
    const value = group.arquivadoEm;
    return !(value === undefined || value === null || value === 0 || value === '');
}

// Turma como objeto de classes ({ courseId, name }) ou como { courseId, studentClass }.
function classKey(cls) {
    if (!cls || typeof cls !== 'object') return null;
    const courseId = String(cls.courseId || '');
    const studentClass = String(cls.name !== undefined ? cls.name : (cls.studentClass || ''));
    return courseId && studentClass ? { courseId, studentClass } : null;
}

// O grupo deste id (ativo ou arquivado), ou null.
function findGroup(memory, id) {
    if (id === undefined || id === null || id === '') return null;
    const wanted = String(id);
    return groupList(memory).find(group => String(group.id) === wanted) || null;
}

// Grupos ativos (não arquivados) da turma, na ordem gravada.
function activeGroupsForClass(memory, cls) {
    const key = classKey(cls);
    if (!key) return [];
    return groupList(memory).filter(group => !isGroupArchived(group)
        && String(group.courseId || '') === key.courseId
        && String(group.studentClass || '') === key.studentClass);
}

module.exports = {
    activeGroupsForClass,
    findGroup,
    isGroupArchived,
};
