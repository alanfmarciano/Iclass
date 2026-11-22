const { test, expect } = require('@playwright/test');
const zlib = require('node:zlib');

// Prova do aluno com os tipos novos de questão, Markdown e imagem num celular de 375 px
// (fase 3, P3-S2: AVA-06, UXA-12). Uma prova com as seis formas de resposta, uma imagem
// larga no enunciado, uma tabela larga e um bloco de código comprido: a página nunca rola
// para o lado, a imagem carrega e cabe na largura, a tabela e o código rolam dentro do
// próprio quadro, cada tipo tem o seu campo, e a imagem fecha depois da entrega (D11).
// Usa a Avaliacao_FUTEC_3 do seed (nenhum outro teste usa) e devolve o conteúdo original
// no fim.
async function adminHeaders(request) {
    const response = await request.post('/api/session/admin-login', { data: { email: 'admin@teste.local', password: 'teste' } });
    expect(response.ok(), `login do administrador: ${response.status()}`).toBe(true);
    const who = await response.json();
    return { 'x-admin-session': who.sessionToken };
}
const CLASS = '1DES';
const COURSE = 'curso_legacy_01';
const EXAM = 'Avaliacao_FUTEC_3';

// PNG de 900 x 120 (mais largo que o celular), feito aqui para não depender de arquivo.
function widePng(width = 900, height = 120) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = buffer => {
        let c = 0xffffffff;
        for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) { row[1 + x * 3] = (x * 7) % 256; row[2 + x * 3] = 120; row[3 + x * 3] = 200; }
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

function typedQuestions(imageUrl) {
    return [
        {
            type: 'multiple_choice', points: 1,
            text: `Observe a topologia:\n\n![Topologia em estrela da sala](${imageUrl})\n\n| Máscara | Endereço de rede | Primeiro host | Último host | Broadcast | Hosts |\n| --- | --- | --- | --- | --- | --- |\n| 255.255.255.0 | 192.168.100.0 | 192.168.100.1 | 192.168.100.254 | 192.168.100.255 | 254 |\n\nQual é a topologia?`,
            alternatives: [{ text: 'Estrela' }, { text: 'Anel' }, { text: 'Barramento' }],
            correctAnswer: 'A',
        },
        { type: 'multiple_answer', points: 2, text: 'Quais são protocolos de transporte? (2*3*4 não é protocolo)', alternatives: [{ text: 'TCP' }, { text: '<p>' }, { text: 'UDP' }], correctAnswers: ['A', 'C'] },
        { type: 'true_false', points: 1, text: 'O IPv4 tem **32 bits**.', correctAnswer: 'A' },
        { type: 'numeric', points: 1, text: 'Qual a latência média?', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' } },
        { type: 'short_answer', points: 1, text: 'Qual o nome do endereço 255.255.255.0?', acceptedAnswers: ['Máscara de sub-rede'] },
        {
            type: 'essay', points: 3,
            text: 'Explique a saída do comando:\n\n```\n$ traceroute -n -q 1 -w 2 www.exemplo-de-um-endereco-bem-comprido.com.br 2>&1 | tee /tmp/saida-do-traceroute.txt\n```',
            expectedAnswer: 'Rota até o destino.',
        },
    ];
}

async function startTypedApplication(request, headers, imageUrl) {
    const saved = await request.put(`/api/admin/evaluation/${EXAM}`, {
        headers,
        data: { title: 'Prova com tipos novos', theme: 'Redes', rubric: '', questions: typedQuestions(imageUrl) },
    });
    expect(saved.status(), 'salvar a avaliação com os tipos novos').toBe(200);
    const evaluation = (await saved.json()).evaluation;
    const history = await request.post('/api/admin/exam-history/add', {
        headers,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, type: 'online', label: 'Tipos novos',
            questionNumbers: evaluation.questions.map(question => question.originalNumber),
            printSnapshot: [{
                version: 'A',
                questions: evaluation.questions.map((question, index) => ({
                    originalNumber: question.originalNumber,
                    examNumber: index + 1,
                    text: question.text,
                    questionText: question.text,
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
    const started = await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers, data: { action: 'start' } });
    expect(started.status()).toBe(200);
    return applicationId;
}

test('[UC-PROVA-004] [UC-LAYOUT-001] prova com os seis tipos, imagem, tabela e código num celular de 375 px: nada rola para o lado e a imagem fecha depois da entrega', async ({ browser, request }) => {
    test.setTimeout(90000);
    await request.post('/api/test/seed');
    const admin = await adminHeaders(request);
    const original = await request.get(`/api/admin/evaluation/${EXAM}`, { headers: admin });
    expect(original.status()).toBe(200);
    const originalEvaluation = await original.json();
    const uploaded = await request.post('/api/admin/upload-image', {
        headers: admin,
        multipart: { image: { name: 'topologia.png', mimeType: 'image/png', buffer: widePng() } },
    });
    expect(uploaded.status(), 'envio da imagem pelo editor').toBe(200);
    const imageUrl = (await uploaded.json()).url;
    expect(imageUrl).toMatch(/^\/uploads\//);

    let applicationId = '';
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
        applicationId = await startTypedApplication(request, admin, imageUrl);
        await page.goto('/login');
        await page.getByLabel('E-mail').fill('aluno@teste.local');
        await page.getByLabel('Senha').fill('teste');
        await page.getByRole('button', { name: 'Entrar como aluno' }).click();
        await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });
        const token = await page.evaluate(() => JSON.parse(localStorage.getItem('iclass-v3-auth') || '{}').sessionToken || '');
        expect(token).not.toBe('');
        // Antes de iniciar a tentativa, nem com o nome do arquivo.
        expect((await request.get(`${imageUrl}?access=${encodeURIComponent(token)}`)).status()).toBe(403);

        await page.goto(`/aluno/prova/${EXAM}?applicationId=${applicationId}`);
        await page.getByLabel('Li as instruções e estou pronto para iniciar esta tentativa.').check();
        await page.getByRole('button', { name: 'Iniciar prova' }).click();
        await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible({ timeout: 15000 });

        const image = page.getByRole('button', { name: 'Topologia em estrela da sala' });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth), { message: 'a imagem carregou' }).toBe(900);
        await expect(page.getByRole('region', { name: /Tabela/ })).toBeVisible();

        const layout = await page.evaluate(() => {
            const width = document.documentElement.clientWidth;
            const img = document.querySelector('.question-md img');
            const table = document.querySelector('.question-md-table');
            const pre = document.querySelector('.question-md pre');
            return {
                width,
                pageScroll: document.scrollingElement.scrollWidth,
                imageRight: img.getBoundingClientRect().right,
                imageWidth: img.getBoundingClientRect().width,
                tableScrolls: table.scrollWidth > table.clientWidth,
                tableRight: table.getBoundingClientRect().right,
                preScrolls: pre.scrollWidth > pre.clientWidth,
                preRight: pre.getBoundingClientRect().right,
            };
        });
        expect(layout.width).toBe(375);
        expect(layout.pageScroll, 'a página não rola para o lado').toBeLessThanOrEqual(375);
        expect(layout.imageRight).toBeLessThanOrEqual(375);
        expect(layout.imageWidth).toBeGreaterThan(200);
        expect(layout.tableScrolls, 'a tabela rola dentro do quadro').toBe(true);
        expect(layout.tableRight).toBeLessThanOrEqual(375);
        expect(layout.preScrolls, 'o código rola dentro do quadro').toBe(true);
        expect(layout.preRight).toBeLessThanOrEqual(375);

        // Tocar na imagem abre a imagem grande; Fechar volta para a prova.
        await image.tap();
        const zoomed = page.getByRole('dialog', { name: 'Imagem da questão' });
        await expect(zoomed).toBeVisible();
        await expect.poll(() => zoomed.locator('img').evaluate(img => img.complete && img.naturalWidth)).toBe(900);
        await zoomed.getByRole('button', { name: 'Fechar' }).tap();
        await expect(zoomed).toHaveCount(0);

        // HTML e asteriscos escritos no texto aparecem como foram escritos (ajuste do A5).
        await expect(page.getByText('Quais são protocolos de transporte? (2*3*4 não é protocolo)', { exact: true })).toBeVisible();
        await expect(page.getByRole('checkbox', { name: '<p>' })).toBeVisible();

        // Um campo para cada tipo.
        await page.getByRole('button', { name: /Estrela/ }).tap();
        await page.getByRole('checkbox', { name: /TCP/ }).check();
        await page.getByRole('checkbox', { name: /UDP/ }).check();
        await page.getByRole('radio', { name: 'Verdadeiro' }).check();
        const numeric = page.getByLabel('Sua resposta (número)');
        await expect(numeric).toHaveAttribute('inputmode', 'decimal');
        await numeric.fill('3,5');
        await expect(page.getByText('ms', { exact: true })).toBeVisible();
        const textAnswers = page.getByLabel('Sua resposta', { exact: true });
        await expect(textAnswers).toHaveCount(2);
        await textAnswers.nth(0).fill('Máscara de sub-rede');
        // A dissertativa fica em branco: o diálogo de envio diz qual.
        await expect(page.getByText('0 de 10.000')).toBeVisible();
        expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(375);

        await page.getByRole('button', { name: 'Enviar', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Enviar a prova?' });
        await expect(dialog).toContainText('Você respondeu 5 de 6 questões.');
        await expect(dialog).toContainText('A questão 6 está em branco.');
        await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Enviar a prova?' })).toHaveCount(0);

        // Toque longo (menu) na resposta escrita passa; no texto da questão continua bloqueado.
        const menuPrevented = await page.evaluate(() => {
            const fire = (el) => {
                const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
                el.dispatchEvent(event);
                return event.defaultPrevented;
            };
            return { essay: fire(document.querySelector('[data-exam-answer] textarea')), text: fire(document.querySelector('.question-md')) };
        });
        expect(menuPrevented).toEqual({ essay: false, text: true });

        await textAnswers.nth(1).fill('O traceroute mostra cada salto até o destino.');
        await expect(page.getByText('45 de 10.000')).toBeVisible();
        await page.getByRole('button', { name: 'Enviar', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Enviar a prova?' })).toContainText('Você respondeu 6 de 6 questões.');
        await page.getByRole('button', { name: 'Enviar prova', exact: true }).click();
        await expect(page.getByTestId('awaiting-correction')).toHaveText('Sua prova foi entregue. As dissertativas serão corrigidas.', { timeout: 15000 });

        // Entregue, sem gabarito liberado: a imagem fecha de novo.
        expect((await request.get(`${imageUrl}?access=${encodeURIComponent(token)}`)).status()).toBe(403);
    } finally {
        await context.close();
        if (applicationId) await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: admin, data: { action: 'finish', inProgressPolicy: 'discard' } });
        const { title, theme, rubric, questions } = originalEvaluation;
        const restored = await request.put(`/api/admin/evaluation/${EXAM}`, { headers: admin, data: { title, theme: theme || '', rubric: rubric || '', questions } });
        expect(restored.status(), 'devolver a avaliação original').toBe(200);
    }
});
