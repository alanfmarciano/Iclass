# Casos de uso — Cursos e turmas

## UC-CURSO-001 — Preservar herança e vínculos específicos

- Estado: automatizado
- Tela: `/turmas`
- APIs: `POST /api/admin/courses`, `PUT`/`DELETE /api/admin/courses/:id`, `POST /api/admin/courses/:id/clone`
- Testes: `course-management.spec.js`, `admin-professor-scope.test.js`, `branding-interface-preset.test.js`, `TurmasPage.test.jsx`

Atribuições por escola e curso devem alcançar entidades futuras sem remover vínculos específicos de uma turma. Exclusões e alterações em uma entidade não podem afetar cursos ou turmas fora do escopo.

Criar, alterar, excluir e restaurar curso vão pelo painel (`/api/admin/courses`), que grava só os campos permitidos: nome (1 a 120 caracteres), descrição (até 2.000), escola (existente; só o administrador muda a escola de um curso, e o professor só cria ou duplica curso para uma escola atribuída a ele, para a cópia e as turmas copiadas não ficarem fora do escopo dele) e identidade visual. A estrutura começa vazia e só muda pela rota `/structure`; o resto do corpo é ignorado. O código do curso (também ao duplicar) aceita só letras sem acento, números, `-` e `_`, com até 64 caracteres. Cada mudança fica na auditoria (`course_created`, `course_updated` só quando algo mudou, `course_deleted` e `course_cloned`). As rotas antigas (`/api/courses` com POST, PUT e DELETE) respondem 410 pedindo para recarregar a página (F5), sem gravar nada.

O conteúdo pedagógico e as apostilas estão fora deste ciclo de expansão de testes.
