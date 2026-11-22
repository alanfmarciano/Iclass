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
- O professor não altera, não exclui, não duplica nem recebe na lista um curso fora do escopo dele (403), e só duplica curso para uma escola atribuída a ele: com só a turma atribuída, duplicar para a escola do próprio curso dá 403, porque a cópia nasceria fora do escopo dele.

### Segurança e bordas
Antes, o professor da 1DES lia a mensagem privada enviada a um aluno da 2DES, apagava as mensagens de todas as turmas com um corpo vazio, via as dúvidas (com e-mail) da 2DES e alterava ou excluía curso de outra coordenação.

## UC-CONTA-001 — Minha conta do instrutor

- Estado: automatizado
- Atores: qualquer conta do painel (administrador, professor, Secretaria, Coordenação)
- Telas: avatar do topo (menu Minha conta · Sair) e `/minha-conta`
- APIs: `POST /api/admin/account/profile`, `POST /api/admin/account/end-other-sessions`, `POST /api/admin/change-password`
- Testes: `admin-own-account.test.js`, `MinhaContaPage.test.jsx`, `AccountMenu.test.jsx`

### Dado
Um professor com a conta aberta em dois computadores (o da sala e o de casa).

### Então
- O avatar do topo mostra as iniciais do nome ("Maria da Silva Souza" vira "MS"; sem nome, as do e-mail) e abre o menu com Minha conta e Sair.
- Em Minha conta, o professor corrige o próprio nome; o e-mail e o papel aparecem só para ler (quem muda é o administrador, em Contas). Nome vazio é recusado no campo; o nome novo aparece no topo na hora.
- "Alterar senha" pede a senha atual; as outras sessões da conta saem.
- "Sair dos outros aparelhos" pergunta antes, na janela do IClass; confirmado, o outro computador recebe "Esta sessão foi encerrada pela própria conta em outro aparelho" no pedido seguinte, e este continua conectado.
- A Coordenação (só consulta) também usa Minha conta: é autoatendimento.

### Segurança e bordas
A rota do nome muda só a conta da sessão (um `email` no corpo não troca de conta). Nome igual ao atual não grava nem vai para a auditoria.

## UC-CONTA-002 — Redefinir a senha de outra conta do painel

- Estado: automatizado
- Atores: administrador
- Tela: `/admins/:email` (botão "Redefinir senha")
- API: `POST /api/admin/accounts/reset-password`
- Testes: `admin-own-account.test.js`, `AdminEditPage.test.jsx`

### Dado
Um professor que esqueceu a senha e já errou cinco vezes (login em espera).

### Então
- O administrador abre a conta e usa "Redefinir senha": por padrão o IClass gera uma senha temporária e mostra uma vez, com Copiar; ou o administrador digita uma senha (com a política do instrutor).
- A senha antiga deixa de valer, o login em espera é liberado e o professor sai dos aparelhos onde estava conectado ("A senha desta conta foi redefinida pelo administrador").
- No próximo acesso o professor escolhe uma senha só dele, informando a temporária como senha atual.
- A auditoria (segurança) registra quem redefiniu, para qual conta e de que jeito, sem a senha.

### Segurança e bordas
A própria conta não é redefinida por aqui (a troca é em Minha conta, com a senha atual). Quem não gerencia contas recebe 403, e o botão não aparece para ele.
