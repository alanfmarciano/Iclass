# Casos de uso — Administradores e permissões

## UC-ADMIN-001 — Restringir gestão de contas por perfil

- Estado: automatizado
- Atores: administrador e professor
- Tela: `/admins`
- Regra: `accounts.manage`
- Testes: `admin-access.spec.js` e `admin-rbac-catalog.test.js`

O administrador autorizado deve visualizar e acessar a gestão de contas. O professor não deve ver o item de navegação e não pode obter acesso digitando a URL diretamente ou chamando a API protegida.

## UC-ADMIN-002 — Catálogo RBAC completo

- Estado: automatizado
- Teste: `admin-rbac-catalog.test.js`

Toda rota `/api/admin` deve possuir decisão explícita no catálogo de permissões.

## UC-ADMIN-003 — Escopo do professor nas mensagens, no fórum e nos cursos

- Estado: automatizado
- Atores: administrador, professor e aluno
- Telas: `/monitor` (histórico de mensagens), `/forum`, `/turmas`, `/aluno/modulos`
- APIs: `GET /api/admin/message-history`, `POST /api/admin/message-history/delete`, `POST /api/admin/forum/all`, `GET /api/forum`, `GET /api/courses`, `PUT`/`DELETE /api/admin/courses/:id`, `POST /api/admin/courses/:id/clone`
- Testes: `admin-professor-scope.test.js`

### Dado
Um professor atribuído só à turma 1DES de um curso com duas turmas (1DES e 2DES), com a permissão adicional `course.manage`, e um curso de outra escola.

### Então — servidor e persistência
- O histórico de mensagens do Monitor traz só as mensagens das turmas do professor, inclusive sem turma no pedido; mensagem antiga sem curso vale pela turma quando o nome dela é único.
- Apagar do histórico exige a mensagem ou a turma (400 "Informe a mensagem ou a turma.", também para o administrador); mensagem de outra turma dá 403 "Você não tem acesso a esta mensagem." e nada é apagado.
- O fórum do painel traz só as dúvidas das turmas do professor, dúvida por dúvida; dúvida antiga sem turma que se possa inferir fica só com o administrador.
- O aluno lista as dúvidas só informando curso e turma da matrícula dele (400 "Informe o curso e a turma." sem eles).
- O professor não altera, não exclui, não duplica nem recebe na lista um curso fora do escopo dele (403).

### Segurança e bordas
Antes, o professor da 1DES lia a mensagem privada enviada a um aluno da 2DES, apagava as mensagens de todas as turmas com um corpo vazio, via as dúvidas (com e-mail) da 2DES e alterava ou excluía curso de outra coordenação.
