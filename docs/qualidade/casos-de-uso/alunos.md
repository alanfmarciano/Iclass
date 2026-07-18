# Casos de uso — Alunos e matrículas

## UC-AUTH-001 — Autenticar aluno em ambiente isolado

- Estado: automatizado
- Tela: `/login` e `/aluno`
- Teste: `student-login.spec.js`

O aluno ativo entra somente com sua sessão, acessa o próprio curso e não compartilha autenticação com a janela administrativa. Aluno inativo ou sessão expirada devem ser recusados pelo servidor.

Novos casos de CRUD e matrícula serão adicionados após a fundação, sem incluir apostilas ou conteúdo pedagógico.
