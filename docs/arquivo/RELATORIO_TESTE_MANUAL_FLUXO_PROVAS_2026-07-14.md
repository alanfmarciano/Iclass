# Relatório de teste manual — fluxo de provas

**Data:** 14/07/2026  
**Ambiente:** servidor local isolado em `TEST_MODE`, porta 3132  
**Método:** teste funcional ponta a ponta, operando a interface com cliques, preenchimento de campos e navegação como professor e aluno. Não houve manipulação direta de banco de dados ou chamadas manuais à API para executar o fluxo.

## Resumo executivo

O fluxo principal de aplicação de uma prova funciona: o professor consegue selecionar uma avaliação existente, configurar a aplicação, gerar token, preparar, pausar, retomar, acrescentar tempo, finalizar, consultar resultados e publicar notas. O aluno consegue validar o token, responder, sair, retornar com as respostas preservadas, entregar, visualizar a nota publicada e consultar o gabarito.

Apesar disso, o fluxo ainda não está pronto para uso confiável em produção. A falha mais grave é a falta de isolamento entre aplicações da mesma prova: uma segunda aplicação recém-preparada apareceu no monitor com 13 alunos já iniciados e 13 entregas antigas, antes de qualquer novo acesso. A segunda tentativa do aluno abriu corretamente com 0/4 respostas, mas o monitor e os resultados continuam misturando dados históricos da prova com a aplicação atual.

Também não foi encontrada uma interface para criar uma prova do zero ou editar o conteúdo das questões. O professor só consegue trabalhar com avaliações já existentes e alterar seleção, ordem e parâmetros de aplicação.

## Dados criados para o teste

O aluno abaixo foi cadastrado integralmente pela interface administrativa:

- **Nome:** Aluno Auditoria Provas
- **E-mail:** aluno.auditoria.provas@teste.local
- **Matrícula:** 2026-AUD-PROVAS
- **Curso:** Curso Técnico em TI (Legado)
- **Turma:** 1DES — Manhã
- **Status:** Ativo

A senha temporária não foi registrada neste relatório.

## Avaliação utilizada

- **Prova:** Sistemas Operacionais + Dispositivos — `Avaliacao_FUTEC_1`
- **Questões:** 4
- **Configuração da primeira aplicação:** 2 versões, 10 minutos, 1 tentativa, token obrigatório
- **Token da primeira aplicação:** `NFEJS`
- **Configuração da segunda aplicação:** 2 versões, 10 minutos, 2 tentativas, token obrigatório
- **Token da segunda aplicação:** `GLMRV`

## Resultado dos cenários

| Cenário | Resultado | Evidência observada |
|---|---|---|
| Criar aluno pela interface | Aprovado | Mensagem “Aluno cadastrado”; aluno associado ao curso e à turma corretos. |
| Selecionar prova existente | Aprovado | A avaliação `Avaliacao_FUTEC_1` foi localizada entre 15 provas. |
| Criar prova do zero | Reprovado / indisponível | Não existe ação de criação de prova ou editor de questões. “Editor de Conteúdo” edita materiais em Markdown, não avaliações. |
| Editar enunciado e alternativas | Reprovado / indisponível | Nenhum controle de edição de questão foi encontrado no fluxo do professor. |
| Remover e restaurar questão da seleção | Aprovado | A seleção passou de 4/4 para 3/4; “Atualizar” restaurou 4/4. |
| Sortear novamente | Aprovado | A ordem das questões foi alterada. |
| Configurar quantidade, versões, duração e tentativas | Aprovado com ressalva | Valores foram aceitos, mas não foram recarregados corretamente ao revisitar a prova. |
| Ativar e regenerar token | Aprovado | Token mudou de `NHEVE` para `NFEJS`; segunda aplicação gerou `GLMRV`. |
| Salvar configuração online | Parcial | Gerou “Online #1”, mas marcou as questões como usadas antes da aplicação iniciar. |
| Preparar aplicação | Parcial | Aplicação ficou “Em andamento”, mas herdou entregas de aplicações anteriores. |
| Pausar e retomar | Aprovado | Estado e cronômetro responderam aos comandos do professor. |
| Acrescentar cinco minutos | Aprovado | Cronômetro aumentou de aproximadamente 3:01 para 7:54. |
| Finalizar aplicação | Aprovado com risco | A aplicação foi encerrada, mas sem confirmação para uma ação global e irreversível. |
| Token inválido | Aprovado | `ABCDE` exibiu “Token incorreto”. |
| Token válido | Aprovado com ressalva | O token abriu diretamente a prova em andamento, sem tela de instruções ou confirmação de início. |
| Responder e salvar automaticamente | Aprovado | A interface exibiu horário de salvamento e preservou 2/4 respostas. |
| Sair da prova e voltar | Aprovado com ressalva | A saída não pediu confirmação; ao retornar com o token, respostas e tempo foram preservados. |
| Trocar de aba/janela durante a prova | Reprovado | Nenhum aviso, bloqueio ou alerta de foco foi registrado; monitor permaneceu com zero alertas. |
| Entregar prova | Aprovado com risco | Entrega concluída e nota 10,0 calculada, mas sem confirmação antes do envio irreversível. |
| Bloquear nova tentativa após atingir o limite | Aprovado | Com limite 1, o cartão mostrou “Tentativas esgotadas” e não abriu nova prova. |
| Liberar e começar a segunda tentativa | Aprovado no aluno | Após configurar 2 tentativas, apareceu “Tentativa 2 de 2” e a prova abriu limpa com 0/4 respostas. |
| Monitorar segunda aplicação | Reprovado | Antes do novo acesso, o monitor já mostrava 13 iniciados, 13 entregues e o aluno de auditoria como “Finalizou 4/4”. |
| Consultar resultados | Parcial | O aluno apareceu com nota 10,0, mas a página agregou “13 alunos · 73 entregas”, misturando histórico da prova. |
| Publicar notas | Aprovado | Houve confirmação nativa; publicação mudou o aluno de 0/1 para 1/1. |
| Ver nota publicada como aluno | Aprovado | Dashboard exibiu nota geral 10,0 e módulo com “Nota publicada 10,0”. |
| Ver gabarito | Aprovado | Dialog mostrou resultado 10,0, 4/4 acertos, versão A e comparação entre resposta e alternativa correta. |

## Defeitos e lacunas

### P-001 — Aplicações da mesma prova não são isoladas

**Severidade:** Crítica  
**Área:** modelo de aplicação, monitor e resultados

**Esperado:** cada vez que o professor prepara uma prova deve ser criada uma aplicação independente, com identificador próprio, alunos inicialmente ausentes e contadores zerados. Tentativas e entregas precisam pertencer a essa aplicação.

**Obtido:** a primeira preparação já abriu com 14 alunos, 12 iniciados e 12 entregues. Depois da entrega do aluno novo, o monitor mostrou 13 iniciados e 13 entregues. Ao finalizar e preparar a mesma prova novamente, a nova aplicação começou em 10:00, mas já exibiu 13 iniciados, 13 entregues e o aluno novo como “Finalizou A — 4/4”. A página de resultados exibiu “13 alunos · 73 entregas”.

**Impacto:** monitoramento incorreto, risco de publicação ou encerramento sobre dados errados, impossibilidade de distinguir turmas, datas e reaplicações, relatórios contaminados e potencial quebra de regras de tentativa.

**Observação:** a segunda tentativa do aluno abriu com 0/4 respostas, portanto a limpeza da tentativa existe no runner, mas não no estado agregado da aplicação.

### P-002 — Não há criação de prova nem edição de questões

**Severidade:** Alta  
**Área:** autoria de avaliações

**Esperado:** o professor deve poder criar uma prova, cadastrar questões, alterar enunciado, alternativas, resposta correta e demais atributos previstos na especificação.

**Obtido:** o fluxo apresenta somente provas já existentes. A página “Editor de Conteúdo” é destinada a materiais/apostilas em Markdown. Não há botão de nova prova nem edição das questões selecionadas.

**Impacto:** o professor não consegue executar o fluxo completo solicitado sem dados previamente carregados por outro meio.

### P-003 — “Salvar online” consome as questões antes da aplicação

**Severidade:** Alta  
**Área:** histórico e controle de reutilização

**Esperado:** salvar uma configuração em rascunho não deve registrar uso efetivo das questões até a aplicação ser preparada ou iniciada.

**Obtido:** após “Salvar online”, o histórico ganhou “Online #1” e todas as quatro questões passaram a mostrar “Já usada: Online #1”, enquanto a prova ainda estava com status “Não aplicada”.

**Impacto:** banco de questões e regras de não repetição ficam incorretos por simples salvamento ou teste de configuração.

### P-004 — Troca de foco/aba não é detectada

**Severidade:** Alta  
**Área:** integridade da aplicação

**Esperado:** ao perder foco ou trocar de aba, o sistema deve aplicar a política definida: alertar o aluno, registrar o evento e informar o professor; se configurado, bloquear ou encerrar.

**Obtido:** foi aberta outra aba real do navegador e, após alguns segundos, a prova continuou sem aviso. O monitor permaneceu com zero alertas.

**Impacto:** o controle antifraude descrito para provas online não funciona.

### P-005 — Cronômetro começa quando o professor prepara a prova

**Severidade:** Alta  
**Área:** duração da tentativa

**Esperado:** se a duração é individual, os 10 minutos devem começar quando o aluno confirma o início. Se o tempo é coletivo, a interface deve deixar essa regra explícita e oferecer sala de espera/início sincronizado.

**Obtido:** o cronômetro começou em “Preparar agora”. O aluno entrou na primeira tentativa com aproximadamente 7:28 restantes e na segunda com 8:05, embora ainda não tivesse iniciado essas tentativas.

**Impacto:** alunos que entram depois perdem tempo sem clareza, gerando inequidade e contestação de prova.

### P-006 — Sair da prova não exige confirmação

**Severidade:** Média  
**Área:** runner do aluno

**Esperado:** a navegação para fora de uma prova ativa deve explicar que a tentativa continuará contando tempo e confirmar a saída.

**Obtido:** clicar em “Provas” saiu imediatamente. O salvamento e a retomada funcionaram, mas sem qualquer aviso.

### P-007 — Entrega definitiva não exige confirmação

**Severidade:** Média  
**Área:** runner do aluno

**Esperado:** “Enviar prova” deve abrir um resumo, informar questões em branco e pedir confirmação explícita.

**Obtido:** ao clicar em “Enviar prova (4/4)”, a prova foi encerrada imediatamente e exibiu “Prova enviada!”.

### P-008 — Finalização global da aplicação não exige confirmação

**Severidade:** Alta  
**Área:** monitor do professor

**Esperado:** encerrar a prova para toda a turma deve exigir confirmação com nome da prova, turma e consequência para alunos ainda ativos.

**Obtido:** “Finalizar” encerrou imediatamente `Avaliacao_FUTEC_1` e o monitor mudou para outra prova ativa.

### P-009 — Token válido inicia a prova sem etapa de confirmação

**Severidade:** Média  
**Área:** entrada do aluno

**Esperado:** após validar o token, o aluno deve ver instruções, duração, tentativas, regras de foco e um botão “Iniciar prova”.

**Obtido:** o token válido abriu diretamente a primeira questão com o cronômetro em andamento.

### P-010 — Configuração aplicada não é recarregada no editor

**Severidade:** Alta  
**Área:** configuração da prova

**Esperado:** ao retornar à prova, o formulário deve refletir a última configuração salva/aplicada ou deixar explícito que se trata de uma nova aplicação com valores padrão.

**Obtido:** após a primeira aplicação, a tela voltou a mostrar 4 versões, 60 minutos, tentativas em branco e token desativado, embora a aplicação anterior tivesse 2 versões, 10 minutos, 1 tentativa e token obrigatório.

**Impacto:** grande chance de o professor preparar uma reaplicação com parâmetros incorretos.

### P-011 — Estados “salvo”, “preparado” e “aplicado” não são claros

**Severidade:** Média  
**Área:** ciclo de vida da prova

**Esperado:** estados distintos e compreensíveis: rascunho, configurada, preparada/sala de espera, em andamento, pausada e finalizada.

**Obtido:** “Salvar online” criou histórico e uso de questões, mas manteve “Não aplicada”; “Preparar agora” iniciou imediatamente o cronômetro; “Iniciar” continuou disponível no monitor mesmo quando a aplicação já aparecia “Em andamento”.

## Recomendações priorizadas

1. Criar uma entidade de aplicação com `applicationId` único e relacionar a ela turma, prova, configuração, token, relógio, tentativas, respostas, eventos de foco, entregas e publicação. Nunca agregar o monitor apenas por nome/chave da prova.
2. Separar claramente `Exam`, `ExamApplication`, `StudentAttempt` e `Submission`, com migração do histórico existente e filtros por aplicação em monitor e resultados.
3. Implementar a autoria completa de provas e questões prevista nos documentos, incluindo validação, edição e persistência pela interface.
4. Definir uma máquina de estados explícita: rascunho → configurada → sala de espera → em andamento → pausada → finalizada. O cronômetro só deve começar no evento correspondente à política escolhida.
5. Registrar `visibilitychange`, perda de foco e troca de tela como eventos auditáveis, com política configurável e visualização no monitor.
6. Adicionar confirmações para saída, entrega e finalização global, com resumo do impacto.
7. Criar uma etapa pré-prova após o token, contendo instruções, duração, número da tentativa, regras de foco e confirmação de início.
8. Recarregar a configuração persistida ou apresentar claramente os valores padrão de uma nova aplicação.
9. Adicionar testes automatizados E2E para duas aplicações consecutivas da mesma prova, duas tentativas do mesmo aluno, saída/retomada, cronômetro, publicação e isolamento dos resultados.

## Conclusão

O caminho básico aluno–professor está funcional e a experiência visual permite completar uma prova. A publicação de nota e o gabarito também funcionaram corretamente. Contudo, a ausência de autoria, o cronômetro global pouco explícito, a falta de confirmações e, sobretudo, a mistura de dados entre aplicações impedem considerar o módulo seguro para produção. A prioridade técnica deve ser corrigir o modelo de isolamento por aplicação antes de ampliar o fluxo ou liberar uso real.

Este trabalho foi exclusivamente de diagnóstico e documentação; nenhuma correção de produto foi implementada.
