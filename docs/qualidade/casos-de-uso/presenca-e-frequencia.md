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
