const { test, expect } = require('@playwright/test');

const LEGACY_COURSE = 'Curso Técnico em TI (Legado)';
const FUTURE_COURSE = 'Curso Herança E2E';
const FUTURE_CLASS = '3DES E2E';

async function saveAssignments(page, dialog) {
    const saved = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/admin/teacher-assignments'
    ), { timeout: 60000 });
    await dialog.getByRole('button', { name: 'Salvar atribuições', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).toBeHidden({ timeout: 15000 });
}

test('[UC-CURSO-001] central gerencia heranças por escola e curso sem perder a turma específica', async ({ page, browser, request }) => {
    test.setTimeout(180000);
    await request.post('/api/test/seed');

    await page.goto('/login');
    await page.getByRole('button', { name: 'Administrador', exact: true }).click();
    // Seed + login assíncronos podem passar dos 5s padrão sob carga (ver visual-layout).
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    await page.getByRole('link', { name: 'Cursos e turmas', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Cursos e turmas', exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Buscar curso ou turma')).toBeVisible();
    await expect(page.getByLabel('Filtrar por escola')).toBeVisible();
    await expect(page.getByLabel('Filtrar por professor')).toBeVisible();
    await expect(page.getByLabel('Filtrar por status')).toBeVisible();
    await expect(page.getByLabel('Somente sem professor')).toBeVisible();

    // Atribuição ampla pela escola e herança em um curso criado depois do vínculo.
    await page.getByRole('button', { name: /Paulo Professor.*Turma específica/ }).click();
    let assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Escola inteira/ }).check();
    await saveAssignments(page, assignmentDialog);
    await expect(page.getByRole('button', { name: /Paulo Professor.*Escola.*Turma específica/ })).toBeVisible();

    await page.getByRole('button', { name: 'Novo curso', exact: true }).click();
    let courseDialog = page.getByRole('dialog', { name: 'Novo curso' });
    await courseDialog.getByLabel('Código do curso').fill('HERANCA_E2E');
    await courseDialog.getByLabel('Nome').fill(FUTURE_COURSE);
    await courseDialog.getByLabel('Descrição').fill('Curso temporário para validar herança por escola.');
    await courseDialog.getByLabel('Escola').selectOption({ label: 'IClass' });
    await courseDialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(courseDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: FUTURE_COURSE, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Paulo Professor.*Escola/ })).toBeVisible();

    // Remover o vínculo da escola não remove a atribuição específica existente em 1DES.
    await page.getByRole('button', { name: /Paulo Professor.*Escola/ }).click();
    assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Escola inteira/ }).uncheck();
    await saveAssignments(page, assignmentDialog);
    await expect(page.getByText('Nenhum professor atribuído.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Excluir', exact: true }).click();
    let confirmDialog = page.getByRole('dialog', { name: 'Excluir curso?' });
    await confirmDialog.getByRole('button', { name: 'Excluir', exact: true }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: LEGACY_COURSE, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Paulo Professor.*Turma específica/ })).toBeVisible();

    // Atribuição pelo curso é herdada por turma criada depois do vínculo.
    await page.getByRole('button', { name: /Paulo Professor.*Turma específica/ }).click();
    assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Curso inteiro/ }).check();
    await saveAssignments(page, assignmentDialog);

    await page.getByRole('button', { name: 'Nova turma', exact: true }).click();
    const classDialog = page.getByRole('dialog', { name: 'Nova turma' });
    await classDialog.getByLabel('Nome da turma').fill(FUTURE_CLASS);
    // "Período" do Manhã/Tarde/Noite virou "Turno" (B8): "Período letivo" é outro campo.
    await classDialog.getByLabel('Turno').selectOption('Noite');
    await classDialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(classDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: FUTURE_CLASS, exact: true })).toBeVisible();
    await expect(page.getByText('· Curso', { exact: true })).toHaveCount(3);

    await page.getByRole('button', { name: /Paulo Professor.*Curso.*Turma específica/ }).click();
    assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Curso inteiro/ }).uncheck();
    await saveAssignments(page, assignmentDialog);
    await expect(page.getByText('· Turma específica', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Sem professor', { exact: true })).toHaveCount(2);

    // Um curso com duas turmas gera dois contextos independentes e o card inteiro entra na turma.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Selecione o curso e a turma', exact: true })).toBeVisible();
    const firstClassCards = page.getByRole('button', { name: `Entrar em ${LEGACY_COURSE}, turma 1DES`, exact: true });
    const futureClassCards = page.getByRole('button', { name: `Entrar em ${LEGACY_COURSE}, turma ${FUTURE_CLASS}`, exact: true });
    // Espera os cartões: eles chegam depois do título quando a máquina está carregada.
    await expect(firstClassCards.first()).toBeVisible();
    await expect(futureClassCards.first()).toBeVisible();
    // O gate atual também pode repetir um contexto na seção "Recentes".
    await futureClassCards.last().click();
    await expect(page.getByTitle('Trocar curso ou turma')).toContainText(FUTURE_CLASS);

    await page.goto('/turmas');
    await page.getByRole('button', { name: `Excluir turma ${FUTURE_CLASS}`, exact: true }).click();
    confirmDialog = page.getByRole('dialog', { name: 'Excluir turma?' });
    await confirmDialog.getByRole('button', { name: 'Excluir', exact: true }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: FUTURE_CLASS, exact: true })).toHaveCount(0);

    // Em outra sessão, o professor continua vendo somente o curso da sua turma específica.
    const professorContext = await browser.newContext();
    const professorPage = await professorContext.newPage();
    await professorPage.goto('/login');
    await professorPage.getByRole('button', { name: 'Professor', exact: true }).click();
    await expect(professorPage.getByRole('heading', { name: 'Selecione o curso e a turma', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(professorPage.getByRole('heading', { name: LEGACY_COURSE, exact: true })).toBeVisible();
    await expect(professorPage.getByRole('button', { name: `Entrar em ${LEGACY_COURSE}, turma 1DES`, exact: true })).toHaveCount(1);
    await professorPage.goto('/turmas');
    await expect(professorPage.getByRole('heading', { name: 'Cursos e turmas', exact: true })).toBeVisible();
    await expect(professorPage.getByRole('button', { name: 'Novo curso', exact: true })).toHaveCount(0);
    await expect(professorPage.getByRole('button', { name: 'Atribuir professor', exact: true })).toHaveCount(0);
    await professorContext.close();
});

// Período letivo e disciplinas pela tela Turmas (B8 / P2-S8, FUN-05): criar o período com
// as etapas sugeridas, ligar a turma pelo formulário, gravar carga horária e módulo da
// disciplina e conferir a 375 px que a página e os diálogos não rolam para o lado. No fim
// a turma sai do período (o servidor é o mesmo das outras specs: a Chamada da 1DES não
// pode ficar fora do período).
test('[UC-CURSO-002] período letivo e disciplinas pela tela Turmas, também no celular', async ({ page, request }) => {
    test.setTimeout(120000);
    await request.post('/api/test/seed');
    const ymd = date => date.toISOString().slice(0, 10);
    const today = new Date();
    const inicio = ymd(new Date(today.getTime() - 30 * 86400000));
    const fim = ymd(new Date(today.getTime() + 150 * 86400000));
    const nome = `Período E2E ${Date.now()}`;

    await page.goto('/login');
    await page.getByRole('button', { name: 'Administrador', exact: true }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    await page.goto('/turmas');
    await expect(page.getByRole('heading', { name: 'Períodos letivos' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Novo período letivo', exact: true }).click();
    const termDialog = page.getByRole('dialog', { name: 'Novo período letivo' });
    await termDialog.getByLabel('Nome do período').fill(nome);
    await termDialog.getByLabel('Início', { exact: true }).fill(inicio);
    await termDialog.getByLabel('Fim', { exact: true }).fill(fim);
    await termDialog.getByLabel('Dividir o período em').selectOption('4');
    await termDialog.getByRole('button', { name: 'Sugerir datas das etapas' }).click();
    await expect(termDialog.getByLabel('Início da etapa 1')).toHaveValue(inicio);
    await expect(termDialog.getByLabel('Fim da etapa 4')).toHaveValue(fim);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/academic/terms/create');
    await termDialog.getByRole('button', { name: 'Salvar período' }).click();
    expect((await created).status()).toBe(200);
    await expect(termDialog).toBeHidden();
    const termCard = page.getByRole('list', { name: 'Períodos letivos' }).getByRole('listitem').filter({ hasText: nome });
    await expect(termCard).toBeVisible();
    await expect(termCard.getByRole('list', { name: `Etapas de ${nome}` }).getByRole('listitem')).toHaveCount(4);

    // Liga a 1DES do curso legado ao período pelo formulário da turma.
    await page.getByRole('button').filter({ hasText: LEGACY_COURSE }).first().click();
    await page.getByRole('button', { name: 'Editar turma 1DES', exact: true }).click();
    let classDialog = page.getByRole('dialog', { name: 'Editar turma' });
    const termOption = classDialog.getByLabel('Período letivo').locator('option', { hasText: nome });
    await classDialog.getByLabel('Período letivo').selectOption(await termOption.getAttribute('value'));
    await classDialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(classDialog).toBeHidden();
    await expect(page.getByText(nome, { exact: true }).first()).toBeVisible();
    await expect(termCard).toContainText('1DES');

    // Disciplinas: carga horária e módulo vão e voltam.
    await page.getByRole('button', { name: 'Disciplinas', exact: true }).click();
    let discDialog = page.getByRole('dialog', { name: 'Disciplinas do curso' });
    await discDialog.getByLabel('Carga horária de Fundamentos de TI (horas)').fill('80');
    await discDialog.getByLabel('Professor responsável por Fundamentos de TI').fill('Paulo Professor');
    await discDialog.getByRole('group', { name: 'Módulos de Fundamentos de TI' }).getByRole('checkbox', { name: /^FUTEC/ }).check();
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/course/disciplinas');
    await discDialog.getByRole('button', { name: 'Salvar disciplinas' }).click();
    expect((await saved).status()).toBe(200);
    await expect(discDialog).toBeHidden();
    await page.getByRole('button', { name: 'Disciplinas', exact: true }).click();
    discDialog = page.getByRole('dialog', { name: 'Disciplinas do curso' });
    await expect(discDialog.getByLabel('Carga horária de Fundamentos de TI (horas)')).toHaveValue('80');
    await expect(discDialog.getByRole('group', { name: 'Módulos de Colaboração e Produtividade' }).getByRole('checkbox', { name: /^FUTEC.*\(em Fundamentos de TI\)$/ })).toBeDisabled();

    // No celular (375 px): a página e os diálogos não rolam para o lado. A página é aberta
    // de novo já no celular (o menu lateral começa fechado).
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(discDialog).toBeHidden();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/turmas');
    await expect(page.getByRole('heading', { name: 'Períodos letivos' })).toBeVisible({ timeout: 15000 });
    const noSideScroll = async () => expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(375);
    await noSideScroll();
    await page.getByRole('button', { name: 'Novo período letivo', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Novo período letivo' })).toBeVisible();
    await noSideScroll();
    await page.getByRole('dialog', { name: 'Novo período letivo' }).getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByRole('button').filter({ hasText: LEGACY_COURSE }).first().click();
    await page.getByRole('button', { name: 'Disciplinas', exact: true }).click();
    discDialog = page.getByRole('dialog', { name: 'Disciplinas do curso' });
    await expect(discDialog.getByLabel('Carga horária de Fundamentos de TI (horas)')).toHaveValue('80');
    await noSideScroll();
    await discDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByRole('button', { name: 'Editar turma 1DES', exact: true }).click();
    classDialog = page.getByRole('dialog', { name: 'Editar turma' });
    await noSideScroll();

    // Tira a turma do período de novo.
    await classDialog.getByLabel('Período letivo').selectOption('');
    await classDialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(classDialog).toBeHidden();
    await expect(termCard).toContainText('Nenhuma turma ligada');
});

