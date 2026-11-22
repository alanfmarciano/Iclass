// Telas de entrega e correção das tarefas (fase 3, C8 / P1-f; FUN-01): a prévia da nota
// final e os dias de atraso que o painel mostra antes de salvar saem da mesma conta do
// servidor (assignments.finalScoreFor e latePenaltyPct), e os limites dos campos são os
// de assignments.LIMITS. As contas ficam em web/src/features/admin/tarefas/correctionRules.js
// (sem import, para carregar no Node; correction.js as reexporta para as telas). Antes do
// C8 não havia a tela nem esse módulo: este teste falha no código antigo ao importá-lo.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const assignments = require('../../backend/utils/assignments.js');

const ROOT = path.join(__dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;
let web;

test.before(async () => {
    web = await import(pathToFileURL(path.join(ROOT, 'web', 'src', 'features', 'admin', 'tarefas', 'correctionRules.js')).href);
});

test('[UC-ERRO-003] prévia da nota final da tela = assignments.finalScoreFor em toda nota e desconto', () => {
    for (let score = 0; score <= 100; score += 1) {
        for (let pct = 0; pct <= 100; pct += 1) {
            assert.equal(web.finalScorePreview(score, pct), assignments.finalScoreFor(score, pct), `nota ${score}, desconto ${pct}%`);
        }
    }
    for (const strange of [null, undefined, '', -1, 101, true, 'x', '85', 72.5]) {
        for (const pct of [10, -5, 150, 12.7, '', null, true, 'x']) {
            assert.equal(web.finalScorePreview(strange, pct), assignments.finalScoreFor(strange, pct), `nota ${JSON.stringify(strange)}, desconto ${JSON.stringify(pct)}`);
        }
    }
});

test('[UC-ERRO-003] dias de atraso da tela = os do desconto do servidor (dia iniciado)', () => {
    const task = assignments.normalizeAssignment({ id: 'asg_1700000000000_abcdef', latePolicy: { mode: 'desconto', penaltyPerDayPct: 1, penaltyMaxPct: 100 } });
    const samples = [1, 1000, 59 * 60 * 1000, DAY - 1, DAY, DAY + 1, 2.5 * DAY, 7 * DAY, 40 * DAY];
    for (const lateMs of samples) {
        assert.equal(web.lateDaysStarted(lateMs), assignments.latePenaltyPct(task, lateMs), `atraso ${lateMs} ms`);
    }
    assert.equal(web.lateDaysStarted(0), 0);
});

test('[UC-ERRO-003] limites dos campos da correção = assignments.LIMITS', () => {
    assert.deepEqual({ ...web.CORRECTION_LIMITS }, {
        commentMax: assignments.LIMITS.commentMax,
        manualNoteMax: assignments.LIMITS.manualNoteMax,
        reasonMin: assignments.LIMITS.reasonMin,
        reasonMax: assignments.LIMITS.reasonMax,
        versionsMax: assignments.LIMITS.versionsMax,
    });
});
