# AI_CONTEXT — LMS Professor Alan Marciano

> **Fonte principal de verdade do projeto.**  
> Este arquivo deve ser lido antes de qualquer alteração feita por IA, Codex, Antigravity ou desenvolvedor humano.

---

## 1. Propósito do sistema

Este projeto é um **LMS local-first para uso em sala de aula**, criado para rodar inicialmente no computador do professor/admin e permitir que os alunos acessem conteúdos, avaliações e recursos pela **rede local**, sem depender obrigatoriamente da internet.

O sistema deve evoluir como um **produto comercial de alto nível**, não como protótipo. Cada tela deve ter finalidade real, CRUD funcional quando aplicável, validação, estados de erro/loading/vazio, regras de segurança no servidor e experiência visual profissional.

### Objetivos principais

- Permitir que o professor/admin controle cursos, turmas, alunos, conteúdos, avaliações, presença e resultados.
- Permitir que o aluno acesse apenas conteúdos e provas liberados para sua turma.
- Aplicar provas em tempo real, com validação e correção no servidor.
- Registrar presença, progresso, notas, submissões e histórico do aluno.
- Funcionar em rede local, com painel administrativo e portal do aluno.
- Ser escalável no futuro para uso online, multiunidade ou multiinstituição.
- Ter documentação clara para que a IA implemente módulo por módulo sem quebrar a base existente.

---

## 2. Regra principal para qualquer IA/Codex/Antigravity

Antes de alterar qualquer tela, rota, banco de dados, serviço, regra de negócio, estrutura de arquivos ou componente visual, a IA deve:

1. Ler este arquivo completo.
2. Ler todos os documentos da pasta `/docs`.
3. Mapear a estrutura atual do projeto.
4. Identificar quais arquivos serão alterados.
5. Preservar funcionalidades já existentes.
6. Fazer alterações pequenas, explicáveis e modulares.
7. Validar regras críticas no servidor, não apenas no frontend.
8. Atualizar documentação quando alterar regra, tela, entidade ou fluxo.
9. Explicar o que mudou e como testar.

### Proibições para a IA

A IA **não deve**:

- Criar botão sem função real.
- Criar tela meramente visual sem integração com dados.
- Remover rotas antigas sem justificativa.
- Trocar regra de negócio sem atualizar documentação.
- Fazer validação sensível apenas no frontend.
- Expor gabarito de prova no cliente.
- Permitir que aluno acesse conteúdo não liberado.
- Permitir submissão de prova não liberada.
- Corrigir prova no frontend como fonte de verdade.
- Quebrar compatibilidade com `index.html`, `admin.html` ou documentos existentes sem plano de migração.
- Reescrever o projeto inteiro se uma alteração modular resolver.
- Deixar telas sem estados de carregamento, erro, vazio e sucesso.

---

## 3. Natureza do produto

O LMS deve ser pensado como um software comercial para gestão de sala de aula, com:

- Interface profissional.
- Navegação clara.
- Permissões por perfil.
- Dados completos.
- Histórico e auditoria.
- Segurança básica desde o início.
- Relatórios úteis.
- Backup e restauração.
- Importação e exportação de dados.
- Identidade visual personalizável.
- Capacidade de operar localmente.
- Preparação para escalar no futuro.

### Benchmark funcional

A implementação deve se inspirar em recursos comuns de LMSs maduros, como:

- Organização por curso, módulo, unidade e atividade.
- Gradebook/boletim de notas.
- Progresso por aluno e por turma.
- Competências ou objetivos de aprendizagem.
- Rubricas de correção.
- Relatórios exportáveis.
- Liberação programada ou manual de conteúdo.
- Banco de questões reutilizável.
- Randomização de questões e alternativas.
- Histórico de tentativas.
- Painel do professor em tempo real.
- Página do aluno com progresso, notas e atividades pendentes.

---

## 4. Perfis de usuário

### 4.1 Super Admin

Perfil máximo do sistema.

Pode:

- Gerenciar todos os administradores.
- Configurar identidade visual global.
- Configurar servidor local.
- Ver logs e auditoria.
- Fazer backup e restauração.
- Alterar permissões.
- Acessar todos os cursos, turmas e alunos.

### 4.2 Admin/Instrutor

Perfil principal do professor ou responsável pela operação.

Pode:

- Criar e gerenciar cursos.
- Criar módulos, unidades e materiais.
- Criar avaliações e banco de questões.
- Cadastrar alunos e turmas.
- Liberar conteúdos e provas.
- Acompanhar alunos online.
- Ver presença, progresso, notas e submissões.
- Corrigir questões discursivas, se existirem.
- Exportar relatórios.

### 4.3 Professor Auxiliar / Monitor

Perfil opcional para apoio.

Pode, conforme permissão:

- Visualizar turmas atribuídas.
- Acompanhar presença.
- Ver progresso.
- Corrigir atividades autorizadas.
- Enviar avisos.
- Não deve alterar configurações globais nem excluir dados críticos.

### 4.4 Aluno

Pode:

- Fazer login ou cadastro quando liberado.
- Visualizar cursos/turmas nos quais está matriculado.
- Acessar conteúdos liberados.
- Fazer provas liberadas.
- Consultar notas, progresso e histórico.
- Usar anotações pessoais.
- Atualizar alguns dados pessoais, se permitido.

---

## 5. Estrutura macro do sistema

O produto possui duas grandes áreas:

1. **Portal do Aluno**  
   Base antiga: `index.html`

2. **Painel Admin/Instrutor**  
   Base antiga: `admin.html`

Também deve possuir camadas de suporte:

- API/servidor local.
- Banco de dados/persistência.
- Serviços de autenticação.
- Serviços de liberação em tempo real.
- Serviços de avaliação e correção.
- Serviços de presença.
- Serviços de relatórios.
- Serviços de backup.
- Logs e auditoria.

---

## 6. Módulos obrigatórios do Painel Admin

O painel administrativo deve ter navegação profissional, preferencialmente com sidebar, cabeçalho, busca global, notificações e identificação do usuário logado.

### Menus principais do Admin

1. Dashboard
2. Alunos
3. Turmas
4. Cursos
5. Módulos
6. Unidades/Aulas
7. Biblioteca de Materiais
8. Avaliações
9. Banco de Questões
10. Provas em Tempo Real
11. Presença
12. Progresso
13. Notas e Boletim
14. Submissões
15. Relatórios
16. Avisos/Comunicados
17. Usuários Administrativos
18. Permissões
19. Identidade Visual
20. Configurações do Sistema
21. Servidor Local
22. Backup e Restauração
23. Logs e Auditoria
24. Ajuda/Documentação

Cada menu deve ter função real. Nenhum item deve ser apenas visual.

---

## 7. Dashboard Admin

### Objetivo

Dar ao professor uma visão imediata da operação da turma/sala.

### Deve conter

- Cards de resumo:
  - total de alunos;
  - alunos online agora;
  - turmas ativas;
  - cursos ativos;
  - aulas liberadas hoje;
  - provas liberadas;
  - submissões pendentes;
  - média geral;
  - presença do dia.
- Atividades recentes:
  - alunos que entraram;
  - provas enviadas;
  - conteúdos liberados;
  - alterações administrativas.
- Alertas:
  - alunos sem acesso recente;
  - provas pendentes;
  - erros de servidor;
  - backup atrasado.
- Ações rápidas:
  - criar aluno;
  - criar turma;
  - liberar conteúdo;
  - iniciar prova;
  - registrar presença;
  - exportar relatório.
- Gráficos:
  - evolução da presença;
  - média por turma;
  - progresso por curso;
  - participação em provas.

### Critérios de aceite

- Dashboard deve carregar dados reais.
- Deve funcionar mesmo quando não houver dados, exibindo estado vazio útil.
- Cards devem abrir telas relacionadas ao clicar.
- Não deve mostrar números falsos ou mockados em produção.

---

## 8. Módulo de Identidade Visual

### Objetivo

Permitir que o sistema seja personalizado para o professor, escola, curso ou marca.

### Menus/subseções

1. Logo e marca
2. Cores e paleta
3. Tipografia
4. Tema e aparência
5. Layout do portal do aluno
6. Layout do painel admin
7. Tela de login
8. Certificados e documentos
9. Pré-visualização
10. Restaurar padrões

### Campos e recursos

#### Logo e marca

- Nome da instituição/projeto.
- Nome curto.
- Slogan.
- Upload de logo principal.
- Upload de logo horizontal.
- Upload de logo reduzida/ícone.
- Upload de favicon.
- Texto alternativo da logo.
- Opção de exibir/ocultar nome junto da logo.

#### Cores e paleta

- Cor primária.
- Cor secundária.
- Cor de destaque.
- Cor de fundo.
- Cor de superfície/card.
- Cor de texto principal.
- Cor de texto secundário.
- Cor de sucesso.
- Cor de alerta.
- Cor de erro.
- Cor de informação.
- Paletas predefinidas.
- Campo para código hexadecimal.
- Prévia de contraste e legibilidade.

#### Tipografia

- Fonte principal.
- Fonte de títulos.
- Fonte de textos longos.
- Tamanho base.
- Escala de títulos.
- Peso dos títulos.
- Altura de linha.
- Espaçamento entre letras.

#### Tema e aparência

- Tema claro.
- Tema escuro.
- Tema automático.
- Bordas arredondadas.
- Densidade da interface: confortável, compacta, espaçada.
- Estilo dos botões.
- Estilo dos cards.
- Estilo da sidebar.

#### Tela de login

- Imagem/banner lateral.
- Texto de boas-vindas.
- Mensagem institucional.
- Exibir logo.
- Exibir ajuda de acesso.
- Cor de fundo.

#### Certificados e documentos

- Logo nos documentos.
- Rodapé institucional.
- Assinatura digitalizada, se aplicável.
- Texto padrão de certificado.

### Botões obrigatórios

- Salvar alterações.
- Visualizar como aluno.
- Visualizar como admin.
- Restaurar padrão.
- Cancelar alterações.
- Remover imagem.

### Regras

- Upload deve validar tipo e tamanho de arquivo.
- Sistema deve manter aparência funcional mesmo sem logo.
- Deve aplicar identidade no Portal do Aluno e Painel Admin.
- Deve persistir configurações no servidor/banco.
- Deve registrar alterações importantes em auditoria.

### Critérios de aceite

- Ao trocar cor primária, a mudança deve refletir nas telas principais.
- Ao trocar logo, login e sidebar devem atualizar.
- Deve existir prévia antes de salvar.
- Deve ser possível restaurar padrão.

---

## 9. Módulo de Alunos

### Objetivo

Gerenciar alunos de forma completa, como em um software comercial.

### Menus/subseções

1. Lista de alunos
2. Novo aluno
3. Importar alunos
4. Perfil do aluno
5. Matrículas
6. Presença
7. Progresso
8. Notas
9. Submissões
10. Histórico de acesso
11. Responsáveis/contatos
12. Segurança e senha
13. Arquivados/inativos

### Campos do cadastro de aluno

#### Identificação

- ID interno.
- Matrícula/código do aluno.
- Nome completo.
- Nome social/apelido.
- CPF/documento, se aplicável.
- Data de nascimento.
- Gênero, se necessário e opcional.
- Foto/avatar.
- Status: ativo, inativo, bloqueado, arquivado.

#### Contato

- E-mail.
- Telefone.
- WhatsApp.
- Endereço, se necessário:
  - rua;
  - número;
  - complemento;
  - bairro;
  - cidade;
  - estado;
  - CEP.

#### Acesso

- Login/usuário.
- Senha inicial ou link/código de ativação.
- Exigir troca de senha no primeiro acesso.
- Último acesso.
- Dispositivos/sessões recentes.
- Bloquear/desbloquear acesso.
- Resetar senha.

#### Acadêmico

- Turma principal.
- Cursos vinculados.
- Data de matrícula.
- Data de conclusão, se aplicável.
- Observações pedagógicas.
- Tags: reforço, avançado, atenção, inadimplente, etc.

#### Responsável/contato de emergência

- Nome do responsável.
- Parentesco.
- E-mail do responsável.
- Telefone do responsável.
- Autorização de contato.

### Lista de alunos

Deve conter:

- Busca por nome, e-mail, matrícula, turma.
- Filtros por turma, curso, status, progresso, presença, último acesso.
- Ordenação por nome, matrícula, status, data de cadastro, último acesso.
- Ações em massa:
  - ativar;
  - bloquear;
  - arquivar;
  - mover para turma;
  - exportar;
  - resetar senha;
  - aplicar tag.
- Colunas configuráveis.

### Perfil do aluno

Deve exibir:

- Dados pessoais.
- Turmas e cursos.
- Progresso por curso/módulo/aula.
- Histórico de presença.
- Notas e tentativas.
- Submissões.
- Atividades pendentes.
- Anotações administrativas.
- Histórico de login.
- Linha do tempo do aluno.

### Critérios de aceite

- Cadastro deve validar campos obrigatórios.
- Não deve permitir matrícula duplicada quando ela for obrigatória/única.
- Reset de senha deve funcionar.
- Bloqueio deve impedir login.
- Arquivar aluno não deve apagar histórico.
- Excluir aluno deve ser ação protegida e preferencialmente lógica, não física.

---

## 10. Módulo de Turmas

### Objetivo

Organizar alunos em grupos e controlar liberação de conteúdos, provas, presença e progresso.

### Menus/subseções

1. Lista de turmas
2. Nova turma
3. Visão geral da turma
4. Alunos da turma
5. Curso vinculado
6. Conteúdos liberados
7. Provas liberadas
8. Presença
9. Progresso coletivo
10. Notas da turma
11. Comunicados
12. Configurações da turma
13. Arquivadas

### Campos da turma

- Nome da turma.
- Código curto.
- Descrição.
- Curso vinculado.
- Professor responsável.
- Monitores/professores auxiliares.
- Turno.
- Sala/local.
- Data de início.
- Data de término.
- Status: ativa, pausada, concluída, arquivada.
- Limite de alunos.
- Permitir autoinscrição.
- Código de inscrição.
- Exigir aprovação do admin para entrada.

### Controles da turma

- Adicionar aluno.
- Remover aluno da turma sem apagar aluno.
- Transferir aluno.
- Liberar módulo.
- Liberar unidade/aula.
- Bloquear conteúdo.
- Liberar prova.
- Encerrar prova.
- Reabrir tentativa específica.
- Registrar presença.
- Exportar relatório.

### Critérios de aceite

- Aluno só vê conteúdo liberado para sua turma.
- Alteração de liberação deve refletir em tempo real ou após atualização segura.
- Turma arquivada não deve aparecer como ativa.
- Remover aluno da turma não deve apagar histórico global do aluno.

---

## 11. Módulo de Cursos

### Objetivo

Criar e gerenciar a estrutura pedagógica macro.

### Menus/subseções

1. Lista de cursos
2. Novo curso
3. Estrutura do curso
4. Módulos
5. Unidades/Aulas
6. Avaliações vinculadas
7. Turmas vinculadas
8. Objetivos/competências
9. Configurações de conclusão
10. Certificado
11. Publicação/arquivamento

### Campos do curso

- Título.
- Código.
- Descrição curta.
- Descrição completa.
- Capa/banner.
- Categoria.
- Carga horária.
- Nível: básico, intermediário, avançado.
- Pré-requisitos.
- Objetivos de aprendizagem.
- Competências desenvolvidas.
- Professor responsável.
- Status: rascunho, ativo, pausado, concluído, arquivado.
- Ordem de exibição.
- Permitir certificado.
- Critério de conclusão:
  - percentual mínimo de aulas concluídas;
  - nota mínima;
  - presença mínima;
  - conclusão manual pelo professor.

### Critérios de aceite

- Curso deve permitir módulos ordenáveis.
- Arquivar curso não deve apagar turmas/alunos/histórico.
- Curso sem módulo deve exibir estado vazio com ação para criar módulo.

---

## 12. Módulo de Módulos

### Objetivo

Agrupar unidades/aulas dentro de um curso.

### Campos

- Curso pai.
- Título do módulo.
- Descrição.
- Ordem.
- Carga horária estimada.
- Objetivos do módulo.
- Status: rascunho, publicado, bloqueado, arquivado.
- Liberação automática após módulo anterior, se aplicável.
- Requisitos para desbloqueio.

### Recursos

- Reordenar módulos.
- Duplicar módulo.
- Arquivar módulo.
- Vincular avaliação ao final do módulo.
- Exibir progresso por módulo.

### Critérios de aceite

- Reordenação deve persistir.
- Módulo bloqueado não aparece para o aluno, salvo indicação de bloqueado sem acesso, conforme regra definida.
- Excluir módulo com aulas deve exigir confirmação e preferencialmente arquivar.

---

## 13. Módulo de Unidades/Aulas

### Objetivo

Gerenciar o conteúdo pedagógico consumido pelo aluno.

### Menus/subseções

1. Lista de unidades
2. Nova unidade/aula
3. Editor de conteúdo
4. Materiais anexos
5. Vídeos
6. PDFs/Apostilas
7. Atividades
8. Avaliação vinculada
9. Liberação por turma
10. Pré-visualização como aluno
11. Histórico de versões

### Campos da unidade/aula

- Curso.
- Módulo.
- Título.
- Código/slug.
- Descrição curta.
- Conteúdo principal.
- Objetivos da aula.
- Tempo estimado.
- Ordem.
- Tipo:
  - aula teórica;
  - apostila;
  - vídeo;
  - atividade prática;
  - missão;
  - revisão;
  - avaliação;
  - material complementar.
- Status:
  - rascunho;
  - pronta;
  - publicada;
  - bloqueada;
  - arquivada.
- Pré-requisitos.
- Materiais anexos.
- Avaliação vinculada.
- Permitir anotações do aluno.
- Permitir marcação manual de concluído.
- Exigir tempo mínimo de estudo, se aplicável.

### Materiais permitidos

- PDF.
- Imagem.
- Vídeo local.
- Link externo opcional.
- Arquivo compactado.
- Documento de apoio.
- Texto HTML/Markdown.

### Critérios de aceite

- Aula deve abrir corretamente no portal do aluno quando liberada.
- Aula não liberada não deve ser acessível por URL direta.
- Materiais devem ter validação de arquivo.
- Pré-visualização deve funcionar no admin.
- Alteração em conteúdo publicado deve preservar histórico ou registrar auditoria.

---

## 14. Biblioteca de Materiais

### Objetivo

Centralizar arquivos e conteúdos reutilizáveis.

### Recursos

- Upload de arquivos.
- Organização por pasta/categoria.
- Busca por nome, tipo, curso, módulo, tags.
- Pré-visualização.
- Vincular material a aulas.
- Ver onde o material é usado.
- Substituir arquivo preservando histórico.
- Remover/arquivar material não usado.

### Campos

- Nome.
- Tipo.
- Tamanho.
- Descrição.
- Tags.
- Autor/criador.
- Data de upload.
- Última atualização.
- Uso vinculado.

### Critérios de aceite

- Arquivos não devem ficar órfãos sem rastreabilidade.
- Excluir material usado deve alertar onde ele está vinculado.

---

## 15. Módulo de Avaliações

### Objetivo

Criar provas, exercícios, simulados e avaliações com controle profissional.

### Menus/subseções

1. Lista de avaliações
2. Nova avaliação
3. Configurações da avaliação
4. Questões
5. Banco de questões
6. Rubrica/gabarito
7. Liberação por turma
8. Tentativas
9. Correção
10. Resultados
11. Revisão pelo aluno
12. Exportação

### Campos da avaliação

- Título.
- Código.
- Descrição.
- Curso vinculado.
- Módulo/unidade vinculada.
- Tipo:
  - prova;
  - quiz;
  - simulado;
  - tarefa;
  - diagnóstico;
  - avaliação final;
  - atividade prática.
- Status:
  - rascunho;
  - pronta;
  - liberada;
  - encerrada;
  - arquivada.
- Nota máxima.
- Nota mínima para aprovação.
- Peso.
- Tempo limite.
- Número máximo de tentativas.
- Permitir revisão após envio.
- Mostrar nota imediatamente.
- Mostrar gabarito após encerramento.
- Randomizar questões.
- Randomizar alternativas.
- Usar questões por sorteio.
- Bloquear retorno a questões anteriores, se aplicável.
- Permitir salvar rascunho.
- Mensagem de instrução antes da prova.
- Mensagem após envio.

### Tipos de questão

- Múltipla escolha.
- Única escolha.
- Verdadeiro/falso.
- Dissertativa.
- Resposta curta.
- Associação/relacionar colunas.
- Ordenação.
- Preenchimento de lacunas.
- Upload de arquivo, opcional futuro.

### Campos da questão

- Enunciado.
- Tipo.
- Pontuação.
- Dificuldade.
- Tags.
- Curso/módulo/tópico relacionado.
- Objetivo de aprendizagem relacionado.
- Feedback geral.
- Feedback por alternativa.
- Explicação da resposta correta.
- Status: ativa, rascunho, arquivada.

### Campos da alternativa

- Texto da alternativa.
- Indicador de correta/incorreta.
- Ordem.
- Feedback específico.

### Regras críticas de prova

- O frontend nunca deve receber gabarito antes da hora permitida.
- O servidor deve validar se a avaliação está liberada para a turma do aluno.
- O servidor deve validar se o aluno pertence à turma.
- O servidor deve validar tempo limite, tentativa e status da prova.
- O servidor deve corrigir questões objetivas.
- Questões discursivas devem ficar como pendentes de correção.
- Randomização deve ser registrada por submissão para manter rastreabilidade.
- A mesma prova pode ser aplicada com ordem diferente de questões e alternativas.
- Tentativa duplicada deve ser bloqueada ou controlada conforme configuração.
- Após encerramento, envio deve ser rejeitado, salvo regra de tolerância configurada.

### Critérios de aceite

- Admin consegue criar prova completa.
- Aluno só vê prova liberada.
- Prova não liberada não aceita submissão via API.
- Correção objetiva acontece no servidor.
- Gabarito não fica exposto no frontend.
- Randomização mantém correção correta.
- Histórico de tentativa é preservado.

---

## 16. Banco de Questões

### Objetivo

Permitir reutilização, organização e sorteio de questões.

### Recursos

- Criar questão independente de avaliação.
- Importar questões.
- Filtrar por curso, módulo, unidade, dificuldade, tipo, tag.
- Duplicar questão.
- Arquivar questão.
- Ver em quais avaliações a questão é usada.
- Montar prova por seleção manual.
- Montar prova por sorteio.

### Campos adicionais

- Disciplina/área.
- Tópico.
- Habilidade/competência.
- Nível de dificuldade.
- Tempo médio esperado.
- Fonte/referência.
- Autor.
- Revisado por.
- Data de revisão.

### Critérios de aceite

- Questão usada em prova já aplicada não deve ser alterada sem versionamento ou alerta.
- Banco deve permitir busca rápida e filtros úteis.

---

## 17. Provas em Tempo Real

### Objetivo

Dar ao professor controle da prova durante a aula.

### Recursos

- Selecionar turma.
- Selecionar avaliação.
- Liberar prova agora.
- Agendar liberação.
- Definir tempo de prova.
- Pausar prova.
- Encerrar prova.
- Reabrir para aluno específico.
- Monitorar alunos online.
- Ver quem iniciou.
- Ver quem enviou.
- Ver tempo restante por aluno.
- Ver tentativas com erro.
- Bloquear novas entradas.

### Painel ao vivo

Deve exibir:

- Total de alunos na turma.
- Online agora.
- Iniciaram prova.
- Enviaram prova.
- Pendentes.
- Tempo restante.
- Alertas de reconexão.

### Critérios de aceite

- Liberação deve refletir para alunos da turma.
- Encerramento deve impedir novas submissões.
- Professor deve conseguir acompanhar status real ou atualizado com segurança.

---

## 18. Submissões e Correção

### Objetivo

Registrar e corrigir tentativas dos alunos.

### Campos da submissão

- ID da submissão.
- Aluno.
- Turma.
- Avaliação.
- Tentativa número.
- Início.
- Envio.
- Duração.
- IP/dispositivo, quando possível.
- Respostas enviadas.
- Ordem sorteada de questões.
- Ordem sorteada de alternativas.
- Nota objetiva.
- Nota discursiva.
- Nota final.
- Status:
  - em andamento;
  - enviada;
  - corrigida;
  - pendente de correção;
  - anulada;
  - reaberta.
- Feedback.

### Recursos

- Ver submissão individual.
- Corrigir discursivas.
- Ajustar nota manualmente com justificativa.
- Anular questão para turma.
- Recalcular notas.
- Exportar resultado.
- Liberar revisão para aluno.

### Critérios de aceite

- Toda alteração manual de nota deve registrar auditoria.
- Recalcular notas deve ser ação protegida.
- Aluno não deve ver feedback/gabarito antes da liberação configurada.

---

## 19. Módulo de Presença

### Objetivo

Controlar presença dos alunos na aula, preferencialmente com registro automático ao acessar o sistema.

### Formas de presença

- Presença automática ao login/acesso em rede local.
- Presença manual pelo professor.
- Código de presença exibido em sala.
- QR Code, opcional futuro.
- Ajuste manual com justificativa.

### Campos da presença

- Aluno.
- Turma.
- Curso/aula.
- Data.
- Horário de entrada.
- Horário de saída, se aplicável.
- Status:
  - presente;
  - ausente;
  - atrasado;
  - justificado;
  - saída antecipada.
- Método de registro.
- Registrado por.
- Justificativa.

### Recursos

- Lista de presença por turma.
- Chamada rápida.
- Registro em massa.
- Relatório de frequência.
- Filtro por período.
- Exportação.

### Critérios de aceite

- Login do aluno pode registrar presença conforme configuração da turma/aula.
- Alteração manual deve registrar quem alterou e motivo.
- Presença deve alimentar relatórios e perfil do aluno.

---

## 20. Módulo de Progresso

### Objetivo

Acompanhar evolução do aluno e da turma.

### Indicadores

- Aulas liberadas.
- Aulas acessadas.
- Aulas concluídas.
- Tempo estimado consumido.
- Provas realizadas.
- Média atual.
- Frequência.
- Pendências.
- Último acesso.
- Competências/objetivos concluídos.

### Visualizações

- Progresso por aluno.
- Progresso por turma.
- Progresso por curso.
- Progresso por módulo.
- Ranking opcional, se pedagogicamente adequado.
- Alunos em risco.

### Critérios de aceite

- Progresso deve ser derivado de eventos reais.
- Marcar aula como concluída deve respeitar regra definida.
- Progresso não deve depender apenas de estado visual do frontend.

---

## 21. Notas e Boletim

### Objetivo

Centralizar notas e resultados.

### Recursos

- Boletim por aluno.
- Gradebook por turma.
- Média por avaliação.
- Média por curso.
- Pesos de avaliação.
- Nota mínima.
- Status de aprovação.
- Exportar CSV/PDF.
- Ajuste manual com justificativa.
- Histórico de alterações.

### Critérios de aceite

- Nota final deve ser calculada no servidor.
- Alterações manuais devem gerar log.
- Boletim do aluno deve mostrar apenas dados dele.

---

## 22. Relatórios

### Objetivo

Fornecer dados úteis para operação, acompanhamento pedagógico e prestação de contas.

### Relatórios mínimos

- Lista de alunos.
- Alunos por turma.
- Presença por período.
- Progresso por turma.
- Progresso individual.
- Notas por avaliação.
- Boletim individual.
- Submissões de prova.
- Atividades pendentes.
- Alunos sem acesso recente.
- Histórico de liberações.
- Logs administrativos.

### Filtros

- Curso.
- Turma.
- Aluno.
- Período.
- Status.
- Avaliação.
- Módulo.

### Exportação

- CSV.
- XLSX, se suportado.
- PDF, se suportado.
- Impressão.

### Critérios de aceite

- Relatórios devem usar dados reais.
- Exportação deve respeitar filtros.
- Não deve expor dados de outras turmas para perfis sem permissão.

---

## 23. Avisos e Comunicados

### Objetivo

Permitir comunicação do professor com alunos/turmas.

### Recursos

- Criar aviso.
- Enviar para turma, curso ou aluno específico.
- Fixar aviso.
- Agendar publicação.
- Definir validade.
- Marcar como lido.
- Histórico de avisos.

### Campos

- Título.
- Mensagem.
- Público-alvo.
- Data de publicação.
- Data de expiração.
- Prioridade.
- Anexo opcional.

### Critérios de aceite

- Aluno só vê avisos destinados a ele/sua turma.
- Admin consegue ver alcance e leitura, se implementado.

---

## 24. Usuários Administrativos e Permissões

### Objetivo

Controlar quem pode administrar o sistema.

### Campos do usuário admin

- Nome.
- E-mail/login.
- Perfil.
- Status.
- Último acesso.
- Permissões específicas.
- Turmas/cursos permitidos.
- Senha/reset.

### Permissões mínimas

- Ver dashboard.
- Gerenciar alunos.
- Gerenciar turmas.
- Gerenciar cursos.
- Gerenciar aulas.
- Gerenciar avaliações.
- Liberar conteúdo.
- Liberar prova.
- Ver notas.
- Alterar notas.
- Ver relatórios.
- Exportar dados.
- Gerenciar identidade visual.
- Gerenciar backup.
- Ver auditoria.
- Gerenciar admins.

### Critérios de aceite

- Permissão deve ser validada no servidor.
- Interface deve ocultar ações não permitidas, mas servidor também deve bloquear.
- Super Admin não deve ser removido acidentalmente.

---

## 25. Configurações do Sistema

### Objetivo

Controlar parâmetros gerais do LMS.

### Configurações esperadas

- Nome do sistema.
- Idioma.
- Fuso horário.
- Formato de data e hora.
- Política de senha.
- Tempo de sessão.
- Permitir cadastro público de aluno.
- Exigir aprovação de cadastro.
- Ativar presença por login.
- Tolerância de atraso em prova.
- Configuração de backup automático.
- Caminho dos arquivos locais.
- Limites de upload.
- Modo manutenção.

### Critérios de aceite

- Alterações críticas devem exigir confirmação.
- Configurações devem persistir.
- Configurações sensíveis devem registrar auditoria.

---

## 26. Servidor Local

### Objetivo

Ajudar o professor/admin a operar o LMS em rede local.

### Tela deve exibir

- Status do servidor.
- IP local detectado.
- Porta em uso.
- Link de acesso do aluno.
- Link do painel admin.
- QR Code do link do aluno, se possível.
- Status do banco de dados.
- Status do armazenamento.
- Quantidade de usuários conectados.
- Logs recentes.

### Ações

- Copiar link do aluno.
- Copiar IP/porta.
- Reiniciar servidor, se suportado com segurança.
- Ver logs.
- Testar conexão.
- Gerar QR Code.

### Critérios de aceite

- IP/link exibido deve ser real.
- Se não for possível detectar IP, mostrar instrução útil.
- Reinício do servidor deve ser protegido e confirmado.

---

## 27. Backup e Restauração

### Objetivo

Proteger dados do sistema.

### Recursos

- Backup manual.
- Backup automático.
- Listar backups existentes.
- Restaurar backup.
- Exportar backup.
- Importar backup.
- Ver tamanho/data/status.
- Verificar integridade.

### Dados contemplados

- Alunos.
- Turmas.
- Cursos.
- Aulas.
- Avaliações.
- Questões.
- Submissões.
- Presença.
- Progresso.
- Configurações.
- Identidade visual.
- Arquivos enviados.

### Critérios de aceite

- Backup deve informar sucesso/falha.
- Restauração deve exigir confirmação forte.
- Backup não deve corromper dados ativos.

---

## 28. Logs e Auditoria

### Objetivo

Registrar ações importantes para segurança e rastreabilidade.

### Eventos mínimos

- Login/logout.
- Falha de login.
- Criação/edição/exclusão de aluno.
- Criação/edição/exclusão de turma.
- Liberação/bloqueio de conteúdo.
- Liberação/encerramento de prova.
- Envio de prova.
- Alteração manual de nota.
- Reset de senha.
- Alteração de permissões.
- Backup/restauração.
- Alteração de configuração.

### Campos do log

- ID.
- Usuário.
- Perfil.
- Ação.
- Entidade afetada.
- ID da entidade.
- Data/hora.
- IP/dispositivo, quando possível.
- Detalhes antes/depois, quando aplicável.

### Critérios de aceite

- Logs sensíveis não devem ser editáveis por usuários comuns.
- Auditoria deve ser filtrável por data, usuário, ação e entidade.

---

## 29. Portal do Aluno

### Menus principais

1. Início
2. Meus cursos
3. Aula atual
4. Conteúdos liberados
5. Provas/Atividades
6. Notas
7. Progresso
8. Presença
9. Anotações
10. Avisos
11. Perfil
12. Ajuda
13. Sair

---

## 30. Início do Aluno

### Deve conter

- Saudação personalizada.
- Curso/turma atual.
- Aula atual ou próxima atividade.
- Progresso geral.
- Provas pendentes.
- Avisos recentes.
- Última nota.
- Presença recente.
- Botão continuar estudando.

### Critérios de aceite

- Aluno só vê dados dele.
- Se não houver conteúdo liberado, mostrar mensagem clara.
- Botão continuar deve levar ao próximo conteúdo disponível.

---

## 31. Conteúdos do Aluno

### Recursos

- Ver cursos vinculados.
- Ver módulos liberados.
- Ver aulas liberadas.
- Abrir conteúdo.
- Baixar material, se permitido.
- Marcar aula como concluída, conforme regra.
- Fazer anotações.
- Modo foco.
- Busca de aulas liberadas.

### Estados de aula

- Bloqueada.
- Liberada.
- Em andamento.
- Concluída.
- Pendente de avaliação.

### Critérios de aceite

- Conteúdo bloqueado não deve abrir via URL direta.
- Aluno não deve conseguir alterar progresso de outro aluno.
- Progresso deve persistir no servidor.

---

## 32. Provas do Aluno

### Fluxo

1. Aluno vê prova liberada.
2. Abre instruções.
3. Confirma início.
4. Servidor registra tentativa.
5. Aluno responde.
6. Sistema controla tempo.
7. Aluno envia respostas.
8. Servidor valida e corrige.
9. Resultado aparece conforme configuração.
10. Histórico fica salvo.

### Tela de prova deve conter

- Título.
- Instruções.
- Tempo restante.
- Questões.
- Navegação entre questões.
- Indicador de respondidas/não respondidas.
- Botão salvar rascunho, se suportado.
- Botão enviar.
- Confirmação antes de enviar.

### Critérios de aceite

- Não deve mostrar gabarito indevidamente.
- Não deve aceitar envio fora das regras.
- Deve lidar com atualização/reconexão da página de forma segura.

---

## 33. Perfil do Aluno

### Campos visíveis/editáveis

- Nome.
- Foto/avatar.
- E-mail.
- Telefone.
- Turma.
- Cursos.
- Alterar senha.
- Preferências básicas.

### O aluno não deve poder editar

- Notas.
- Presença.
- Turma.
- Matrícula crítica.
- Permissões.
- Liberações.

---

## 34. Entidades principais do domínio

### AdminUser

- id
- name
- email
- passwordHash
- role
- permissions
- status
- lastLoginAt
- createdAt
- updatedAt

### Student

- id
- enrollmentCode
- fullName
- displayName
- document
- birthDate
- email
- phone
- avatarUrl
- status
- classIds
- courseIds
- passwordHash
- mustChangePassword
- lastLoginAt
- tags
- notes
- createdAt
- updatedAt

### ClassGroup

- id
- name
- code
- description
- courseId
- instructorIds
- studentIds
- status
- startDate
- endDate
- enrollmentEnabled
- enrollmentCode
- releasedItems
- examConfigs
- createdAt
- updatedAt

### Course

- id
- title
- code
- description
- coverUrl
- category
- workloadHours
- level
- objectives
- competencies
- status
- moduleIds
- completionRules
- certificateEnabled
- createdAt
- updatedAt

### Module

- id
- courseId
- title
- description
- order
- objectives
- status
- unitIds
- unlockRules
- createdAt
- updatedAt

### Unit

- id
- courseId
- moduleId
- title
- slug
- description
- content
- type
- order
- estimatedMinutes
- objectives
- materialIds
- assessmentId
- status
- createdAt
- updatedAt

### Material

- id
- name
- type
- path
- size
- tags
- description
- createdBy
- createdAt
- updatedAt

### Assessment

- id
- title
- code
- description
- courseId
- moduleId
- unitId
- type
- status
- maxScore
- passingScore
- weight
- timeLimitMinutes
- attemptLimit
- shuffleQuestions
- shuffleAlternatives
- showScoreImmediately
- showAnswersAfterClose
- questionIds
- createdAt
- updatedAt

### Question

- id
- assessmentId
- bankId
- type
- statement
- score
- difficulty
- tags
- learningObjective
- alternatives
- correctAnswerData
- feedback
- explanation
- status
- version
- createdAt
- updatedAt

### Submission

- id
- assessmentId
- studentId
- classGroupId
- attemptNumber
- startedAt
- submittedAt
- durationSeconds
- answers
- questionOrder
- alternativeOrder
- objectiveScore
- manualScore
- finalScore
- status
- feedback
- gradedBy
- gradedAt
- createdAt
- updatedAt

### ProgressRecord

- id
- studentId
- courseId
- moduleId
- unitId
- status
- progressPercent
- startedAt
- completedAt
- lastAccessAt
- createdAt
- updatedAt

### AttendanceRecord

- id
- studentId
- classGroupId
- courseId
- unitId
- date
- checkInAt
- checkOutAt
- status
- method
- registeredBy
- justification
- createdAt
- updatedAt

### BrandingSettings

- id
- institutionName
- shortName
- slogan
- logoUrl
- iconUrl
- faviconUrl
- primaryColor
- secondaryColor
- accentColor
- backgroundColor
- textColor
- headingFont
- bodyFont
- themeMode
- borderRadius
- updatedBy
- updatedAt

### AuditLog

- id
- userId
- userRole
- action
- entityType
- entityId
- beforeData
- afterData
- ipAddress
- userAgent
- createdAt

---

## 35. Regras críticas de segurança e negócio

1. Todo acesso sensível deve exigir autenticação.
2. Permissões devem ser validadas no servidor.
3. Aluno só acessa dados dele.
4. Aluno só vê conteúdo liberado para sua turma.
5. Aluno só inicia prova liberada para sua turma.
6. Servidor valida início, envio, tempo e tentativa da prova.
7. Correção objetiva acontece no servidor.
8. Gabarito nunca deve ser enviado ao frontend antes da liberação permitida.
9. Alteração manual de nota exige permissão e auditoria.
10. Reset de senha exige permissão.
11. Excluir dados críticos deve ser evitado; preferir arquivar/inativar.
12. Relatórios devem respeitar permissões.
13. Backup/restauração deve ser protegido.
14. Uploads devem validar tipo, tamanho e destino.
15. Dados de aluno devem ser tratados com cuidado e não expostos indevidamente.

---

## 36. Estados obrigatórios de interface

Toda tela relevante deve tratar:

- Loading/carregando.
- Vazio/sem dados.
- Erro de servidor.
- Erro de validação.
- Sem permissão.
- Sucesso.
- Confirmação antes de ação destrutiva.
- Estado offline/servidor indisponível, quando aplicável.

---

## 37. Padrão de CRUD comercial

Para cada cadastro, implementar quando aplicável:

- Listar.
- Buscar.
- Filtrar.
- Ordenar.
- Criar.
- Visualizar detalhes.
- Editar.
- Arquivar/inativar.
- Excluir apenas quando seguro.
- Exportar.
- Importar, quando fizer sentido.
- Ações em massa.
- Histórico/auditoria.

---

## 38. Padrão de botões e ações

Todo botão visível deve ter:

- Ação real implementada.
- Estado disabled quando não puder executar.
- Feedback de sucesso/erro.
- Validação antes da ação.
- Confirmação para ação perigosa.
- Permissão verificada.

Botões comuns:

- Novo.
- Salvar.
- Cancelar.
- Editar.
- Arquivar.
- Restaurar.
- Excluir.
- Importar.
- Exportar.
- Duplicar.
- Visualizar.
- Filtrar.
- Limpar filtros.
- Atualizar.

---

## 39. Ordem recomendada de implementação por IA

A IA deve implementar em módulos, nesta ordem preferencial:

1. Estrutura base e autenticação.
2. Layout Admin e Portal do Aluno.
3. Identidade visual.
4. Alunos.
5. Turmas.
6. Cursos.
7. Módulos.
8. Unidades/Aulas.
9. Biblioteca de materiais.
10. Liberação de conteúdo por turma.
11. Banco de questões.
12. Avaliações.
13. Provas em tempo real.
14. Submissões e correção.
15. Progresso.
16. Presença.
17. Notas/boletim.
18. Relatórios.
19. Avisos.
20. Usuários administrativos e permissões.
21. Configurações do sistema.
22. Servidor local.
23. Backup/restauração.
24. Logs/auditoria.
25. Refinamento visual e responsividade.
26. Testes e documentação final.

---

## 40. Checklist antes de implementar um módulo

Antes de codificar, a IA deve responder internamente:

- Este módulo já existe parcialmente?
- Quais arquivos serão alterados?
- Existe rota/API correspondente?
- Existe modelo de dados?
- Existe validação no servidor?
- Existe estado de loading/erro/vazio?
- Existem permissões envolvidas?
- O módulo afeta Portal do Aluno, Admin ou ambos?
- Precisa atualizar `/docs`?
- Como testar após concluir?

---

## 41. Definição de pronto por módulo

Um módulo só pode ser considerado pronto se:

- A tela principal existe.
- Os menus/subseções esperados existem.
- Os campos principais existem.
- CRUD funciona quando aplicável.
- Dados persistem.
- Validações funcionam.
- Permissões são respeitadas.
- Erros são tratados.
- Estados vazios são tratados.
- Botões executam ações reais.
- O módulo foi testado manualmente.
- A documentação foi atualizada quando necessário.

---

## 42. Testes mínimos obrigatórios

### Autenticação

- Login admin válido.
- Login aluno válido.
- Login inválido.
- Bloqueio de usuário.
- Logout.

### Alunos

- Criar aluno.
- Editar aluno.
- Bloquear aluno.
- Resetar senha.
- Vincular aluno à turma.

### Turmas

- Criar turma.
- Adicionar/remover aluno.
- Vincular curso.
- Liberar conteúdo.
- Liberar prova.

### Conteúdos

- Criar curso/módulo/aula.
- Liberar aula para turma.
- Aluno acessar aula liberada.
- Aluno ser bloqueado em aula não liberada.

### Avaliações

- Criar prova.
- Criar questões.
- Liberar prova.
- Aluno iniciar prova.
- Aluno enviar prova.
- Servidor corrigir.
- Gabarito permanecer oculto quando configurado.

### Presença

- Registrar presença automática.
- Registrar presença manual.
- Exportar relatório.

### Relatórios

- Filtrar por turma.
- Exportar dados.
- Validar permissões.

---

## 43. Prompt padrão para Codex/Antigravity implementar módulo

Use este prompt ao pedir implementação:

```md
Leia `AI_CONTEXT.md` e os documentos da pasta `/docs` antes de alterar qualquer arquivo.

Implemente o módulo: [NOME DO MÓDULO].

Regras obrigatórias:
- Preserve a estrutura existente.
- Não remova funcionalidades antigas sem justificar.
- Não crie botões decorativos.
- Todo botão visível deve executar uma ação real ou ficar claramente desabilitado.
- Valide regras críticas no servidor.
- Trate loading, erro, vazio, sucesso e sem permissão.
- Atualize documentação se alterar regra, entidade ou fluxo.

Antes de codificar:
1. Analise a estrutura do projeto.
2. Liste os arquivos que serão alterados.
3. Explique o plano de implementação.

Depois de codificar:
1. Explique o que mudou.
2. Explique como testar.
3. Aponte limitações ou próximos passos.
```

---

## 44. Prompt padrão para revisar módulo existente

```md
Leia `AI_CONTEXT.md` e `/docs`.

Revise o módulo: [NOME DO MÓDULO].

Verifique:
- Se todos os menus esperados existem.
- Se todos os campos comerciais necessários existem.
- Se os botões têm ação real.
- Se há CRUD completo quando aplicável.
- Se há validação no servidor.
- Se há permissões.
- Se há estados de loading, erro, vazio e sucesso.
- Se há persistência real.
- Se há integração com Portal do Aluno quando necessário.

Gere um relatório com:
- O que está pronto.
- O que está parcial.
- O que está apenas visual.
- O que está quebrado.
- O que falta implementar.
- Prioridade de correção.
```

---

## 45. Prompt padrão para auditoria geral do projeto

```md
Leia `AI_CONTEXT.md` e `/docs`.

Faça uma auditoria completa do projeto LMS.

Mapeie:
- Stack usada.
- Estrutura de pastas.
- Telas existentes.
- Rotas existentes.
- Componentes principais.
- Serviços/API.
- Modelos de dados.
- Funcionalidades completas.
- Funcionalidades parciais.
- Botões sem ação.
- Telas apenas visuais.
- Falhas de backend.
- Falhas de banco/persistência.
- Falhas de segurança.
- Falhas de responsividade.
- Falhas de documentação.

Crie um arquivo `docs/LMS_FUNCTIONALITY_AUDIT.md` com prioridade de implementação.
```

---

## 46. Observações sobre compatibilidade com a base antiga

A base antiga possui referências a:

- `index.html` como Portal do Aluno.
- `admin.html` como Painel Admin/Instrutor.
- Documentos na pasta `/docs`.

Qualquer modernização deve respeitar a lógica existente. Se for necessário migrar para estrutura moderna, a IA deve:

1. Explicar motivo.
2. Preservar funcionalidades.
3. Criar plano de migração.
4. Evitar quebrar acesso atual.
5. Atualizar documentação.

---

## 47. Prioridade máxima do produto

A prioridade do LMS é funcionar bem em sala de aula.

Portanto, os pontos mais importantes são:

1. Professor controlar a aula em tempo real.
2. Aluno acessar apenas o que foi liberado.
3. Prova ser segura e corrigida no servidor.
4. Presença e progresso serem registrados.
5. Dados ficarem salvos com segurança.
6. Interface ser clara e profissional.
7. IA implementar sem quebrar o que já existe.

---

## 48. Resumo executivo para a IA

Este LMS deve ser um sistema comercial completo, local-first, para gestão de cursos, turmas, alunos, aulas, avaliações, presença, progresso e relatórios.

O Admin/Instrutor controla tudo: cursos, módulos, unidades, alunos, turmas, provas, liberações, presença, notas e relatórios.

O Aluno acessa apenas o que está liberado para ele/sua turma, realiza atividades e provas, acompanha notas, progresso e presença.

Toda regra crítica deve ser validada no servidor. O frontend é apenas interface, nunca fonte única de verdade.

Nenhuma tela deve ser criada pela metade. Nenhum botão deve ser decorativo. Nenhum módulo deve ser considerado pronto sem dados reais, validação, permissões, estados de interface e critérios de teste.
