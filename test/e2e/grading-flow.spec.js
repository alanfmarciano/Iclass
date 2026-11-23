const { test, expect } = require('@playwright/test');

// Critérios de avaliação de ponta a ponta (fase 3, B9 / P2-S4; FUN-02): o administrador
// liga os critérios do curso com duas etapas, o professor cria um seminário na 2ª etapa,
// lança 8,5 e publica, o quadro mostra a média final e a situação, e o aluno vê "Minhas
// notas". No celular (375 px), o quadro e o portal não rolam para o lado.

async function quickLogin(page, button) {
    await page.goto('/login');
    await page.getByRole('button', { name: button, exact: true }).first().click();
}

async function enterWorkspace(page) {
    // Seed + login assíncronos podem passar dos 5s padrão sob carga (ver visual-layout).
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    const gate = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
    await expect(gate.or(page.getByRole('link', { name: 'Resultados', exact: true }))).toBeVisible({ timeout: 15000 });
    if (await gate.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /Entrar em .+, turma/ }).first().click();
    }
}

async function noHorizontalScroll(page, context) {
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(widths.scroll, `${context}: largura da página`).toBeLessThanOrEqual(375);
    expect(widths.body, `${context}: largura do corpo`).toBeLessThanOrEqual(375);
}

test.beforeEach(async ({ request }) => {
    await request.post('/api/test/seed');
});

test('[UC-NOTAS-008] critérios com 2 etapas, seminário de 8,5 na 2ª etapa, quadro com situação e "Minhas notas" do aluno', async ({ browser }) => {
    test.setTimeout(120000);

    // 1) Administrador liga os critérios do curso com duas etapas.
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await quickLogin(admin, 'Administrador');
    await expect(admin).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    await admin.getByRole('link', { name: 'Cursos e turmas', exact: true }).click();
    await admin.getByRole('button', { name: 'Critérios de avaliação', exact: true }).click();
    const criterios = admin.getByRole('dialog', { name: 'Critérios de avaliação' });
    await expect(criterios.getByLabel('Média mínima (0 a 10)')).toBeVisible();
    await criterios.getByRole('switch', { name: 'Usar critérios de avaliação neste curso' }).click();
    await criterios.getByLabel('Nome da etapa 1', { exact: true }).fill('1º bimestre');
    await criterios.getByRole('button', { name: 'Adicionar etapa', exact: true }).click();
    await criterios.getByLabel('Nome da etapa 2', { exact: true }).fill('2º bimestre');
    await criterios.getByRole('button', { name: 'Ver prévia', exact: true }).click();
    await expect(criterios.getByText(/^Com esta regra, /)).toBeVisible();
    await criterios.getByRole('button', { name: 'Salvar critérios', exact: true }).click();
    // O curso de teste já tem notas publicadas: o motivo é pedido.
    const motivo = admin.getByRole('dialog', { name: 'Salvar os critérios de avaliação?' });
    await motivo.getByRole('textbox').fill('Regimento da escola com bimestres');
    const saved = admin.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/grading/criteria');
    await motivo.getByRole('button', { name: 'Salvar critérios', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(criterios).toBeHidden();
    await adminContext.close();

    // 2) Professor cria o seminário na 2ª etapa, lança 8,5 para a Alice e publica.
    const profContext = await browser.newContext();
    const prof = await profContext.newPage();
    await quickLogin(prof, 'Professor');
    await enterWorkspace(prof);
    await prof.getByRole('link', { name: 'Resultados', exact: true }).click();
    await prof.getByRole('tab', { name: 'Plano de avaliação' }).click();
    const plano = prof.getByRole('region', { name: 'Plano de avaliação da turma' });
    await plano.getByRole('button', { name: 'Nova avaliação da turma', exact: true }).click();
    const nova = prof.getByRole('dialog', { name: 'Nova avaliação da turma' });
    await nova.getByLabel('Título').fill('Seminário de redes');
    await nova.getByLabel('Tipo').selectOption({ label: 'Seminário' });
    await nova.getByLabel('Etapa').selectOption({ label: '2º bimestre' });
    await nova.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(nova).toBeHidden();
    await expect(plano.getByRole('listitem', { name: 'Seminário de redes' })).toBeVisible();

    await prof.getByRole('button', { name: 'Lançar nota', exact: true }).click();
    const lancar = prof.getByRole('dialog', { name: 'Lançamento manual' });
    const aliceValue = await lancar.getByLabel('Aluno').locator('option', { hasText: 'Alice Aluna' }).getAttribute('value');
    await lancar.getByLabel('Aluno').selectOption(aliceValue);
    await lancar.getByLabel('Prova ou avaliação').selectOption({ label: 'Seminário - Seminário de redes' });
    await expect(lancar.getByLabel('Acertos')).toHaveCount(0);
    await expect(lancar.getByRole('button', { name: 'Cartão-resposta' })).toHaveCount(0);
    await lancar.getByLabel('Nota (0 a 10)').fill('8,5');
    const created = prof.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/submissions/create');
    await lancar.getByRole('button', { name: 'Salvar nota', exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(200);
    expect(createdResponse.request().postDataJSON()).toMatchObject({ grade: 8.5 });
    await expect(lancar).toBeHidden();

    await prof.getByRole('button', { name: 'Publicar notas', exact: true }).click();
    const publicar = prof.getByRole('dialog', { name: /^Publicar \d+ nota\(s\) para os alunos\?$/ });
    await publicar.getByRole('button', { name: 'Publicar', exact: true }).click();
    await expect(publicar).toBeHidden();

    // 3) Quadro de notas: etapas, média final e situação vindas do servidor.
    await prof.getByRole('tab', { name: 'Quadro de notas' }).click();
    const quadro = prof.getByRole('region', { name: 'Quadro de notas da turma' });
    const tabela = quadro.getByRole('table');
    await expect(tabela.getByRole('columnheader', { name: 'Média final' })).toBeVisible();
    await expect(tabela.getByRole('columnheader', { name: 'Situação' })).toBeVisible();
    await expect(tabela.getByRole('columnheader', { name: /2º bimestre · peso 1/ })).toBeVisible();
    const alice = tabela.getByRole('row').filter({ has: prof.getByRole('rowheader', { name: /Alice Aluna/ }) });
    await expect(alice.getByText('8,5').first()).toBeVisible();
    await expect(alice.getByText(/^(Aprovado|Em recuperação|Cursando|Reprovado por nota|Reprovado por falta)$/)).toBeVisible();

    // No celular: lista de alunos no lugar da tabela, sem rolagem para o lado.
    const phone = await profContext.newPage();
    await phone.setViewportSize({ width: 375, height: 800 });
    await phone.goto('/resultados');
    await phone.getByRole('tab', { name: 'Quadro de notas' }).click();
    const quadroCelular = phone.getByRole('region', { name: 'Quadro de notas da turma' });
    const lista = quadroCelular.getByRole('list', { name: 'Alunos e notas' });
    await expect(lista).toBeVisible();
    await expect(quadroCelular.getByRole('table')).toBeHidden();
    await lista.getByRole('button', { name: /Alice Aluna/ }).click();
    await expect(lista.getByText('Seminário de redes')).toBeVisible();
    await noHorizontalScroll(phone, 'Quadro de notas no celular');
    await phone.getByRole('tab', { name: 'Plano de avaliação' }).click();
    await expect(phone.getByRole('listitem', { name: 'Seminário de redes' })).toBeVisible();
    await noHorizontalScroll(phone, 'Plano de avaliação no celular');
    await profContext.close();

    // 4) Aluno vê "Minhas notas" com a média final, a situação e as etapas.
    const studentContext = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const aluno = await studentContext.newPage();
    // Pelo formulário (o acesso rápido semeia a base de novo).
    await aluno.goto('/login');
    await aluno.getByLabel('E-mail ou matrícula').fill('aluno@teste.local');
    await aluno.getByLabel('Senha', { exact: true }).fill('teste');
    await aluno.getByRole('button', { name: 'Entrar como aluno' }).click();
    await expect(aluno).toHaveURL(/\/aluno/, { timeout: 15000 });
    await aluno.goto('/aluno/provas');
    const minhas = aluno.getByRole('region', { name: 'Minhas notas' });
    await expect(minhas).toBeVisible({ timeout: 15000 });
    await expect(minhas.getByText('Média final', { exact: true })).toBeVisible();
    await expect(minhas.getByText('Notas por etapa')).toBeVisible();
    await expect(minhas.getByText(/1º bimestre/)).toBeVisible();
    await expect(minhas.getByText(/2º bimestre/)).toBeVisible();
    await expect(minhas.getByText(/Média mínima para aprovação: 6,0\./)).toBeVisible();
    await expect(aluno.getByText('Seminário de redes').first()).toBeVisible();
    await noHorizontalScroll(aluno, 'Provas do aluno no celular');
    await studentContext.close();
});
