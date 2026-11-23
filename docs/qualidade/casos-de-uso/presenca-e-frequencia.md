# Presença e frequência

## UC-PRESENCA-001 — Configurar disciplinas e grade horária

**Ator:** administrador.

**Pré-condições:** curso e turma ativos.

**Fluxo principal:**

1. O administrador acessa **Cursos e turmas**.
2. Cadastra as disciplinas disponíveis no curso.
3. Edita a turma, define tolerância, limiar de risco e aulas de cada dia.
4. O sistema valida horários, disciplinas e ordens antes de persistir a grade.

**Resultado esperado:** a grade fica disponível para a chamada e para o cálculo de frequência.

## UC-PRESENCA-002 — Fazer chamada por aula

**Ator:** administrador ou professor autorizado para a turma.

**Pré-condições:** turma com grade no dia selecionado e alunos matriculados.

**Fluxo principal:**

1. O instrutor abre **Chamada** e escolhe a data.
2. Marca cada aula como presente, falta ou justificada.
3. Quando necessário, registra justificativa e indica se a falta é abonada.
4. Salva a chamada.
5. O sistema prioriza a chamada do professor sobre a presença automática e recalcula a frequência geral e por disciplina.

**Resultado esperado:** a chamada é restaurada ao reabrir a data e faltas abonadas não reduzem a frequência.

## UC-DIARIO-001 — Registrar o conteúdo das aulas na Chamada

**Ator:** quem faz a chamada da turma (professor, Professor auxiliar, Secretaria ou administrador); a Coordenação só consulta.

**Pré-condições:** turma aberta (não encerrada) com grade no dia escolhido.

**Fluxo principal:**

1. O instrutor abre **Chamada**, escolhe a data e desce até **Conteúdo das aulas**.
2. Em cada cartão (Aula 1 · 07:30 · Redes), escreve o **Conteúdo ministrado** e, se quiser, a **Atividade**.
3. O sistema salva sozinho 2 s depois da última tecla ("Salvo às 10:42"), só as aulas que mudaram, com a versão que a tela leu.
4. Se outra aba ou outra pessoa gravou antes, o sistema não sobrescreve: a tela mostra o aviso e deixa escolher entre **Ver a versão salva** e **Gravar o meu texto por cima**.

**Resultado esperado:** o diário do dia volta igual ao reabrir a data; a primeira gravação fica na Auditoria como "Diário da aula registrado" e a mudança feita por outra pessoa, ou mais de 24 h depois, como "Diário da aula alterado", com o antes e o depois. O diário nunca é apagado pela tela.

## UC-DIARIO-003 — Exportar a presença por período e curso

**Ator:** quem faz ou consulta a chamada da turma.

**Fluxo principal:**

1. Na **Chamada**, o instrutor toca em **Exportar CSV**.
2. Escolhe o período (o padrão é o mês da data da chamada) e toca em **Baixar CSV**.

**Resultado esperado:** a planilha traz só as datas do período e só a turma daquele curso (a turma com o mesmo nome em outro curso fica de fora).

## UC-DIARIO-004 — O diário no backup

**Resultado esperado:** o diário de classe entra no backup e volta ao restaurar; restaurar um backup de antes desta função mantém o diário atual.
