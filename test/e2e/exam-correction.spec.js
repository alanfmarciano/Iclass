const { test, expect } = require('@playwright/test');

// Correção do professor e revisão do aluno num celular de 375 px (fase 3, P3-S4b / A18:
// AVA-07, UXA-17). O aluno entrega uma prova com uma questão de uma correta e uma
// dissertativa com rubrica; o professor abre "Corrigir provas" pelo aviso de Resultados,
// lança a rubrica e o comentário e conclui (a nota sai do servidor); com a nota
// publicada e o gabarito liberado, o aluno vê os pontos da dissertativa, a rubrica, o
// comentário e a explicação, sem "Errada" na dissertativa. Nenhuma tela rola para o
// lado. Usa a Avaliacao_FUTEC_2 do seed (nenhum outro teste usa) e devolve o conteúdo
// original no fim.
const CLASS = '1DES';
const COURSE = 'curso_legacy_01';
const EXAM = 'Avaliacao_FUTEC_2';
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

async function adminHeaders(request) {
    const response = await request.post('/api/session/admin-login', { data: { email: 'admin@teste.local', password: 'teste' } });
    expect(response.ok(), `login do administrador: ${response.status()}`).toBe(true);
    return { 'x-admin-session': (await response.json()).sessionToken };
}

async function noHorizontalScroll(page, where) {
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(widths.scroll, `${where}: largura da página`).toBeLessThanOrEqual(375);
    expect(widths.body, `${where}: largura do corpo`).toBeLessThanOrEqual(375);
}

const QUESTIONS = [
    { type: 'multiple_choice', points: 1, text: 'Qual a porta padrão do HTTP?', alternatives: [{ text: '80' }, { text: '21' }, { text: '443' }], correctAnswer: 'A', explanation: 'A porta padrão do HTTP é a **80**.' },
    {
        type: 'essay', points: 2, text: 'Explique o que é um protocolo de rede.',
        expectedAnswer: 'Conjunto de regras de comunicação entre computadores.',
        rubric: [{ nome: 'Ideia central', pontos: 1 }, { nome: 'Clareza', pontos: 1 }],
        explanation: 'Protocolo é um acordo de regras para os computadores conversarem.',
    },
];

async function startApplication(request, headers) {
    const saved = await request.put(`/api/admin/evaluation/${EXAM}`, { headers, data: { title: 'Prova de protocolos', theme: 'Redes', rubric: '', questions: QUESTIONS } });
    expect(saved.status(), 'salvar a avaliação').toBe(200);
    const evaluation = (await saved.json()).evaluation;
    const history = await request.post('/api/admin/exam-history/add', {
        headers,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, type: 'online', label: 'Correção',
            questionNumbers: evaluation.questions.map(question => question.originalNumber),
            printSnapshot: [{
                version: 'A',
                questions: evaluation.questions.map((question, index) => ({
                    originalNumber: question.originalNumber, examNumber: index + 1, text: question.text, questionText: question.text,
                    correctAnswer: question.correctAnswer || '',
                    alternatives: (question.alternatives || []).map((alternative, position) => ({ ...alternative, displayLetter: 'ABCDEFGH'[position] })),
                })),
            }],
            shuffleAnswers: false, durationMinutes: 40, waitingRoomMinutes: 0, maxAttempts: 1,
        },
    });
    expect(history.status()).toBe(200);
    const created = await request.post('/api/admin/exam-applications', {
        headers,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, historyId: (await history.json()).entry.id,
            applicationOptions: { timerMode: 'per_attempt', durationMinutes: 40, maxAttempts: 1, waitingRoomDuration: 0, tokenEnabled: false },
        },
    });
    expect(created.status()).toBe(201);
    const applicationId = (await created.json()).application.id;
    expect((await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers, data: { action: 'start' } })).status()).toBe(200);
    return applicationId;
}

test('[UC-CORRECAO-001] [UC-LAYOUT-001] professor corrige a dissertativa no celular e o aluno vê os pontos, a rubrica e o comentário', async ({ browser, request }) => {
    test.setTimeout(150000);
    await request.post('/api/test/seed');
    const admin = await adminHeaders(request);
    const original = await request.get(`/api/admin/evaluation/${EXAM}`, { headers: admin });
    expect(original.status()).toBe(200);
    const originalEvaluation = await original.json();
    let applicationId = '';
    const studentContext = await browser.newContext(PHONE);
    const profContext = await browser.newContext(PHONE);
    try {
        applicationId = await startApplication(request, admin);

        // 1) O aluno entrega: uma correta e a dissertativa escrita.
        const student = await studentContext.newPage();
        await student.goto('/login');
        await student.getByLabel('E-mail').fill('aluno@teste.local');
        await student.getByLabel('Senha').fill('teste');
        await student.getByRole('button', { name: 'Entrar como aluno' }).click();
        await expect(student).toHaveURL(/\/aluno/, { timeout: 15000 });
        await student.goto(`/aluno/prova/${EXAM}?applicationId=${applicationId}`);
        await student.getByLabel('Li as instruções e estou pronto para iniciar esta tentativa.').check();
        await student.getByRole('button', { name: 'Iniciar prova' }).click();
        await expect(student.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible({ timeout: 15000 });
        await student.getByRole('button', { name: /80/ }).first().tap();
        await student.getByLabel('Sua resposta', { exact: true }).fill('São regras para os computadores trocarem dados.');
        await student.getByRole('button', { name: 'Enviar', exact: true }).click();
        await student.getByRole('button', { name: 'Enviar prova', exact: true }).click();
        await expect(student.getByTestId('awaiting-correction')).toBeVisible({ timeout: 15000 });
        expect((await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: admin, data: { action: 'finish', inProgressPolicy: 'discard' } })).status()).toBe(200);

        // 2) O professor vê o aviso em Resultados e corrige pelo celular.
        const prof = await profContext.newPage();
        await prof.goto('/login');
        await prof.getByRole('button', { name: 'Professor', exact: true }).first().click();
        await expect(prof).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
        const gate = prof.getByRole('heading', { name: 'Selecione o curso e a turma' });
        // Contexto novo: a escolha da turma sempre aparece.
        await expect(gate).toBeVisible({ timeout: 15000 });
        await prof.getByRole('button', { name: /Entrar em .+, turma/ }).first().click();
        await expect(gate).toBeHidden({ timeout: 15000 });
        await prof.goto('/resultados');
        const corrigir = prof.getByRole('button', { name: /^Corrigir provas \(\d+\)$/ });
        await expect(corrigir).toBeVisible({ timeout: 15000 });
        await corrigir.click();
        await expect(prof).toHaveURL(/\/resultados\/correcao/);
        await prof.getByRole('combobox', { name: 'Prova' }).selectOption(EXAM);
        await expect(prof.getByText('São regras para os computadores trocarem dados.')).toBeVisible({ timeout: 15000 });
        await expect(prof.getByText('Conjunto de regras de comunicação entre computadores.')).toBeVisible();
        await noHorizontalScroll(prof, 'Corrigir no celular');
        await prof.getByLabel(/Ideia central/).fill('1');
        await prof.getByLabel(/Clareza/).fill('0,5');
        const essay = prof.getByText('São regras para os computadores trocarem dados.').locator('xpath=ancestor::li[1]');
        await essay.getByLabel(/Comentário para o aluno/).fill('Faltou dar um exemplo de protocolo.');
        await prof.getByLabel(/Comentário geral/).fill('Bom trabalho na prova.');
        const bar = prof.getByRole('button', { name: 'Concluir correção' });
        // A barra de Salvar/Concluir fica no pé da tela, sem rolar até o fim.
        const box = await bar.boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(812);
        const posted = prof.waitForResponse(response => response.request().method() === 'POST' && /\/correction$/.test(new URL(response.url()).pathname));
        await bar.click();
        expect((await posted).status()).toBe(200);
        // 1 + 1,5 de 3 pontos: o servidor calcula 8,3.
        await expect(prof.getByText('Correção concluída.')).toBeVisible();
        await expect(prof.getByRole('status').filter({ hasText: 'Correção concluída.' })).toContainText('8,3');
        await noHorizontalScroll(prof, 'Correção concluída');

        // 3) Nota publicada e gabarito liberado (pela API, como em Resultados e Provas).
        const rows = await (await request.get(`/api/admin/submissions?courseId=${COURSE}&studentClass=${CLASS}`, { headers: admin })).json();
        const mine = rows.filter(row => row.examKey === EXAM && row.applicationId === applicationId);
        expect(mine.length).toBe(1);
        expect((await request.post('/api/admin/submissions/publish', { headers: admin, data: { ids: mine.map(row => row.id), published: true } })).status()).toBe(200);
        expect((await request.post('/api/admin/release-item', { headers: admin, data: { studentClass: CLASS, courseId: COURSE, itemKey: `Gabarito_${EXAM}`, released: true } })).status()).toBe(200);

        // 4) O aluno vê a revisão no celular.
        await student.goto('/aluno/provas');
        await student.getByRole('button', { name: /Prova de protocolos/ }).first().click();
        const dialog = student.getByRole('dialog');
        const essayCard = dialog.getByText('Explique o que é um protocolo de rede.').locator('xpath=ancestor::li[1]');
        await expect(essayCard.getByText('1,5 de 2 pontos')).toBeVisible({ timeout: 15000 });
        await expect(dialog.getByText('Faltou dar um exemplo de protocolo.')).toBeVisible();
        await expect(dialog.getByText('Bom trabalho na prova.')).toBeVisible();
        await expect(dialog.getByText('Protocolo é um acordo de regras para os computadores conversarem.')).toBeVisible();
        await expect(essayCard.getByText('Errada', { exact: true })).toHaveCount(0);
        await expect(essayCard.getByText('Ideia central')).toBeVisible();
        // A etiqueta da alternativa fica numa linha própria, abaixo do texto.
        const tag = dialog.getByText('Sua resposta · Correta').first();
        const alt = tag.locator('xpath=..');
        const [tagBox, textBox] = await Promise.all([tag.boundingBox(), alt.locator('.question-md').first().boundingBox()]);
        expect(tagBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
        await noHorizontalScroll(student, 'Revisão do aluno');
    } finally {
        await studentContext.close();
        await profContext.close();
        if (applicationId) await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: admin, data: { action: 'finish', inProgressPolicy: 'discard' } });
        await request.post('/api/admin/release-item', { headers: admin, data: { studentClass: CLASS, courseId: COURSE, itemKey: `Gabarito_${EXAM}`, released: false } });
        const { title, theme, rubric, questions } = originalEvaluation;
        const restored = await request.put(`/api/admin/evaluation/${EXAM}`, { headers: admin, data: { title, theme: theme || '', rubric: rubric || '', questions } });
        expect(restored.status(), 'devolver a avaliação original').toBe(200);
    }
});
