const { test, expect } = require('@playwright/test');

const STUDENT = {
    name: 'Aluno Fluxo E2E',
    email: 'aluno.fluxo.e2e@teste.local',
    password: 'Fluxo@123',
};

async function createStudentContext(browser) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        // O Chromium sem interface não garante a API nativa de tela cheia entre
        // páginas. Emulamos somente essa fronteira do navegador; os eventos e
        // todas as regras de pausa/liberação continuam passando pela aplicação.
        let fullscreenElement = null;
        const emitChange = () => document.dispatchEvent(new Event('fullscreenchange'));
        Object.defineProperty(Document.prototype, 'fullscreenElement', {
            configurable: true,
            get: () => fullscreenElement,
        });
        Object.defineProperty(Document.prototype, 'webkitFullscreenElement', {
            configurable: true,
            get: () => fullscreenElement,
        });
        Object.defineProperty(Element.prototype, 'requestFullscreen', {
            configurable: true,
            value: async function requestFullscreen() {
                fullscreenElement = this;
                emitChange();
            },
        });
        Object.defineProperty(Element.prototype, 'webkitRequestFullscreen', {
            configurable: true,
            value: async function webkitRequestFullscreen() {
                fullscreenElement = this;
                emitChange();
            },
        });
        Object.defineProperty(Document.prototype, 'exitFullscreen', {
            configurable: true,
            value: async function exitFullscreen() {
                fullscreenElement = null;
                emitChange();
            },
        });
    });
    return context;
}

async function enterProfessorWorkspace(page) {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Professor', exact: true }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    const chooseCourse = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
    if (await chooseCourse.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /Entrar em .+, turma/ }).first().click();
    }
    await expect(page.getByRole('link', { name: 'Provas', exact: true })).toBeVisible();
}

async function createStudentFromUi(page) {
    await page.getByRole('link', { name: 'Alunos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Alunos', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Novo aluno' }).click();
    await page.getByLabel('Nome completo').fill(STUDENT.name);
    await page.getByLabel('E-mail/login').fill(STUDENT.email);
    await page.getByLabel('Matrícula/código').fill('E2E-2026-001');
    await page.getByLabel('Senha inicial').fill(STUDENT.password);
    await page.getByRole('button', { name: 'Vínculo' }).click();
    await page.getByLabel('Curso').selectOption('curso_legacy_01');
    await page.getByLabel(/1DES/).check();
    await page.getByRole('button', { name: 'Salvar aluno' }).click();
    await expect(page.getByText('Aluno cadastrado')).toBeVisible();
    await expect(page.getByText(STUDENT.email)).toBeVisible();
}

async function createAndEditExamFromUi(page) {
    await page.getByRole('link', { name: 'Provas', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Provas', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nova prova' })).toBeEnabled();
    await page.getByRole('button', { name: 'Nova prova' }).click();

    await page.getByLabel('Título da prova').fill('Prova E2E fluxo');
    await page.getByRole('textbox', { name: 'Tema', exact: true }).fill('Fluxo completo');
    await page.locator('textarea').first().fill('Leia, responda e revise antes de enviar.');
    await page.getByPlaceholder('Texto da questão').fill('Qual opção representa o fluxo correto?');
    const initialAlternatives = page.getByPlaceholder(/^Alternativa [A-D]$/);
    await initialAlternatives.nth(0).fill('Preparar, iniciar e responder');
    await initialAlternatives.nth(1).fill('Finalizar antes de iniciar');
    await initialAlternatives.nth(2).fill('Responder sem aplicação');
    await initialAlternatives.nth(3).fill('Misturar aplicações');
    await page.getByRole('button', { name: 'Salvar prova' }).click();
    await expect(page.getByText('Prova criada')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Prova E2E fluxo' })).toBeVisible();

    await page.getByRole('button', { name: 'Editar conteúdo' }).click();
    await page.getByLabel('Título da prova').fill('Prova E2E fluxo editada');
    await page.getByRole('button', { name: 'Adicionar questão' }).click();
    const questionTexts = page.getByPlaceholder('Texto da questão');
    await questionTexts.nth(1).fill('O que acontece quando o aluno sai da prova?');
    const alternatives = page.getByPlaceholder(/^Alternativa [A-D]$/);
    await alternatives.nth(4).fill('As respostas permanecem salvas');
    await alternatives.nth(5).fill('A aplicação é apagada');
    await alternatives.nth(6).fill('A turma é removida');
    await alternatives.nth(7).fill('A tentativa troca de aluno');
    await page.getByRole('button', { name: 'Subir' }).last().click();
    await page.getByRole('button', { name: 'Salvar no banco' }).first().click();
    await expect(page.getByText('Questão salva no banco')).toBeVisible();
    await page.getByRole('button', { name: 'Banco de questões' }).click();
    const bankDialog = page.getByRole('dialog', { name: 'Banco de questões' });
    await expect(bankDialog.getByText('O que acontece quando o aluno sai da prova?')).toBeVisible();
    await bankDialog.getByRole('button', { name: 'Editar', exact: true }).first().click();
    await bankDialog.getByRole('textbox', { name: 'Categoria', exact: true }).fill('Fluxo E2E revisado');
    await bankDialog.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByText('Questão do banco atualizada')).toBeVisible();
    await bankDialog.getByRole('button', { name: 'Adicionar', exact: true }).first().click();
    await expect(page.getByText('Questão adicionada à prova')).toBeVisible();
    await bankDialog.getByRole('button', { name: 'Fechar' }).click();
    await page.getByRole('button', { name: 'Salvar prova' }).click();
    await expect(page.getByText('Prova atualizada')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Prova E2E fluxo editada' })).toBeVisible();
}

async function prepareAndStartFromUi(page) {
    await page.getByLabel('Quantidade de questoes').fill('3');
    await page.getByLabel('Tentativas permitidas').fill('2');
    await page.getByLabel('Duracao (min)').fill('15');
    const historySaved = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && response.url().includes('/api/admin/exam-history/add')
    ), { timeout: 60000 });
    const applicationPrepared = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && /\/api\/admin\/exam-applications$/.test(new URL(response.url()).pathname)
    ), { timeout: 90000 });
    await page.getByRole('button', { name: 'Preparar e abrir monitor' }).click();
    expect((await historySaved).status()).toBe(200);
    expect((await applicationPrepared).status()).toBe(201);
    await expect(page).toHaveURL(/\/monitor\?.*applicationId=/, { timeout: 30000 });
    const applicationId = new URL(page.url()).searchParams.get('applicationId');
    expect(applicationId).toBeTruthy();
    await expect(page.getByText('Preparada', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Iniciar prova e avisar alunos', exact: true }).click();
    await expect(page.getByText('Sala de espera', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Liberação em/)).toBeVisible();
    const addedMinuteResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/api/admin/exam-applications/${applicationId}/control`));
    await page.getByRole('button', { name: '+1 min', exact: true }).click();
    expect((await addedMinuteResponse).status()).toBe(200);
    await expect(page.getByText('Tempo da sala de espera ajustado.')).toBeVisible();
    const removedMinuteResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/api/admin/exam-applications/${applicationId}/control`));
    await page.getByRole('button', { name: '−1 min', exact: true }).click();
    expect((await removedMinuteResponse).status()).toBe(200);
    await page.getByRole('button', { name: 'Iniciar agora', exact: true }).click();
    await expect(page.getByText('Em andamento', { exact: true }).first()).toBeVisible();
    return applicationId;
}

async function loginCreatedStudent(page) {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(STUDENT.email);
    await page.getByLabel('Senha').fill(STUDENT.password);
    await page.getByRole('button', { name: 'Entrar como aluno' }).click();
    await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });
    await page.getByRole('link', { name: 'Provas', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Provas', exact: true })).toBeVisible();
}

async function openAndStartAttempt(page) {
    const released = page.getByText('Liberada', { exact: true }).first();
    await expect(released).toBeVisible();
    await released.click();
    await expect(page.getByRole('heading', { name: 'Instruções da prova' })).toBeVisible();
    await page.getByLabel('Li as instruções e estou pronto para iniciar esta tentativa.').check();
    await page.getByRole('button', { name: 'Iniciar prova' }).click();
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible();
}

async function answerAllAndSubmit(page) {
    const alternativeGroups = page.locator('div.space-y-2.pl-9');
    const count = await alternativeGroups.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
        await alternativeGroups.nth(index).getByRole('button').first().click();
    }
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.getByRole('button', { name: 'Enviar prova', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Prova enviada!' })).toBeVisible();
}

test('[UC-PROVA-001][UC-PROVA-002] fluxo completo de prova pela interface preserva retomada, tentativas e isola reaplicação', async ({ browser, request }) => {
    test.setTimeout(300000);
    await request.post('/api/test/seed');

    const professorContext = await browser.newContext();
    const professor = await professorContext.newPage();
    await enterProfessorWorkspace(professor);
    await createStudentFromUi(professor);
    await createAndEditExamFromUi(professor);
    const firstApplicationId = await prepareAndStartFromUi(professor);

    let studentContext = await createStudentContext(browser);
    let student = await studentContext.newPage();
    await loginCreatedStudent(student);
    await openAndStartAttempt(student);

    const firstGroup = student.locator('div.space-y-2.pl-9').first();
    await firstGroup.getByRole('button').first().click();
    await expect(student.getByText(/1\/3 respondidas/)).toBeVisible();
    await student.waitForTimeout(900);
    await student.getByRole('main').getByRole('button', { name: 'Sair', exact: true }).click();
    await student.getByRole('button', { name: 'Salvar e sair' }).click();
    await expect(student).toHaveURL(/\/aluno\/provas/, { timeout: 15000 });

    await student.getByText('Liberada', { exact: true }).first().click();
    await expect(student.getByRole('heading', { name: 'Prova pausada' })).toBeVisible();
    await studentContext.close();
    await professor.bringToFront();
    const studentRow = professor.getByRole('row').filter({ hasText: STUDENT.email });
    await expect(studentRow.getByRole('button', { name: 'Foco' })).toBeVisible({ timeout: 15000 });
    await studentRow.getByRole('button', { name: 'Foco' }).click();
    studentContext = await createStudentContext(browser);
    student = await studentContext.newPage();
    await loginCreatedStudent(student);
    await student.getByText('Liberada', { exact: true }).first().click();
    const resumeFullscreen = student.getByRole('button', { name: 'Voltar à tela cheia', exact: true });
    if (await resumeFullscreen.isVisible().catch(() => false)) await resumeFullscreen.click();
    await expect(student.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(student.getByText(/1\/3 respondidas/)).toBeVisible();
    await answerAllAndSubmit(student);

    await studentContext.close();
    studentContext = await createStudentContext(browser);
    student = await studentContext.newPage();
    await loginCreatedStudent(student);
    await openAndStartAttempt(student);
    await answerAllAndSubmit(student);

    await studentContext.close();
    studentContext = await createStudentContext(browser);
    student = await studentContext.newPage();
    await loginCreatedStudent(student);
    await expect(student.getByText('Tentativas esgotadas')).toBeVisible();

    await professor.bringToFront();
    await professor.getByRole('button', { name: 'Finalizar', exact: true }).click();
    await professor.getByRole('button', { name: 'Finalizar aplicação' }).click();
    await expect(professor.getByText('Finalizada', { exact: true })).toBeVisible();

    await professor.getByRole('link', { name: 'Provas', exact: true }).click();
    await professor.getByText('Prova E2E fluxo editada', { exact: true }).click();
    await professor.getByRole('button', { name: 'Aplicar online' }).first().click();
    const applyDialog = professor.getByRole('dialog', { name: 'Aplicar prova novamente' });
    await applyDialog.getByLabel('Tentativas permitidas').fill('1');
    await applyDialog.getByLabel('Sala de espera (min)').fill('0');
    await professor.getByRole('button', { name: 'Aplicar prova' }).click();
    await expect(professor).toHaveURL(/\/monitor\?.*applicationId=/, { timeout: 15000 });
    await expect(professor.getByText('Nova aplicação preparada. Abrindo o Monitor Online.')).toBeVisible();
    await professor.getByRole('button', { name: 'Iniciar prova e avisar alunos', exact: true }).click();
    const secondApplicationId = new URL(professor.url()).searchParams.get('applicationId');
    expect(secondApplicationId).toBeTruthy();
    expect(secondApplicationId).not.toBe(firstApplicationId);

    await student.bringToFront();
    await student.reload();
    await expect(student.getByText('Tentativa 1 de 1')).toBeVisible();
    await expect(student.getByText('Liberada', { exact: true })).toBeVisible();

    await studentContext.close();
    await professorContext.close();
});
