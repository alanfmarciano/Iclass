// Hora da escola (backend/utils/schoolTime.js, fundação C0b da fase 3; K7 e K21 do
// plano). Prazo digitado como data + hora no relógio da escola vira instante em ms, e a
// data civil de um instante sai no fuso da escola, com horário de verão de verdade
// (America/Sao_Paulo de 2018 e 2019, America/New_York de 2026) e sem depender do
// relógio nem do fuso da máquina que roda o teste.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-school-time-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');

const schoolTime = require('../../backend/utils/schoolTime.js');
const settingsUtil = require('../../backend/utils/settings.js');
const db = require('../../backend/database.js');

const iso = ms => (ms === null ? null : new Date(ms).toISOString());
const SP = 'America/Sao_Paulo';

test('[UC-HORARIO-001] prazo digitado no relógio da escola vira o instante certo', () => {
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-11-20', '23:59', SP)), '2026-11-21T02:59:00.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-11-20', '00:00', SP)), '2026-11-20T03:00:00.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-11-20', '07:30:15', SP)), '2026-11-20T10:30:15.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-06-01', '12:00', 'Asia/Kolkata')), '2026-06-01T06:30:00.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-06-01', '12:00', 'UTC')), '2026-06-01T12:00:00.000Z');
    // Ida e volta: o instante mostrado no fuso é a data e a hora digitadas.
    const due = schoolTime.deadlineFromLocal('2027-02-28', '18:45', SP);
    assert.deepEqual([schoolTime.schoolDateOf(due, SP), schoolTime.localParts(due, SP).time], ['2027-02-28', '18:45']);
});

test('[UC-HORARIO-001] horário de verão: a hora que não existe vale depois do pulo e a que se repete vale a primeira', () => {
    // São Paulo, 04/11/2018: o relógio pulou de 00:00 para 01:00.
    const gap = schoolTime.deadlineFromLocal('2018-11-04', '00:30', SP);
    assert.equal(iso(gap), '2018-11-04T03:30:00.000Z');
    assert.equal(schoolTime.localParts(gap, SP).time, '01:30');
    assert.equal(iso(schoolTime.deadlineFromLocal('2018-11-04', '01:00', SP)), '2018-11-04T03:00:00.000Z');
    // São Paulo, 16/02/2019: à meia-noite o relógio voltou para 23:00; 23:30 aconteceu duas vezes.
    assert.equal(iso(schoolTime.deadlineFromLocal('2019-02-16', '23:30', SP)), '2019-02-17T01:30:00.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2019-02-17', '00:30', SP)), '2019-02-17T03:30:00.000Z');
    // Nova York, 2026: pulo em 08/03 às 02:00 e volta em 01/11 às 02:00.
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-03-08', '02:30', 'America/New_York')), '2026-03-08T07:30:00.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-11-01', '01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
    assert.equal(iso(schoolTime.deadlineFromLocal('2026-11-01', '03:00', 'America/New_York')), '2026-11-01T08:00:00.000Z');
});

test('[UC-HORARIO-001] entrada inválida devolve null (quem chama recusa com 400)', () => {
    [
        ['2026-02-30', '10:00'], ['2026-13-01', '10:00'], ['20-11-2026', '10:00'], ['', '10:00'], [null, '10:00'],
        ['2026-02-10', '24:00'], ['2026-02-10', '10:60'], ['2026-02-10', '7:30'], ['2026-02-10', ''], ['2026-02-10', undefined],
    ].forEach(([date, time]) => assert.equal(schoolTime.deadlineFromLocal(date, time, SP), null, `${date} ${time}`));
    assert.equal(schoolTime.deadlineFromLocal('2026-02-10', '10:00', 'Brasil/Hora'), null, 'fuso desconhecido');
    assert.equal(schoolTime.isValidLocalDate('2028-02-29'), true);
    assert.equal(schoolTime.isValidLocalDate('2027-02-29'), false);
    assert.equal(schoolTime.isValidLocalTime('23:59'), true);
    assert.equal(schoolTime.isValidLocalTime('23:59:60'), false);
    assert.equal(schoolTime.schoolDateOf('não é data', SP), null);
    assert.equal(schoolTime.localParts(NaN, SP), null);
});

test('[UC-HORARIO-001] data civil e partes do instante no fuso da escola', () => {
    // 02:30 UTC de 19/11 ainda é 18/11 em São Paulo (23:30, quarta-feira).
    const at = Date.UTC(2026, 10, 19, 2, 30);
    assert.equal(schoolTime.schoolDateOf(at, SP), '2026-11-18');
    assert.equal(schoolTime.schoolDateOf(at, 'UTC'), '2026-11-19');
    assert.deepEqual(schoolTime.localParts(at, SP), {
        date: '2026-11-18', time: '23:30', year: 2026, month: 11, day: 18, hour: 23, minute: 30, second: 0, weekday: 3, timezone: SP,
    });
    assert.equal(schoolTime.localParts(Date.UTC(2026, 10, 22, 12), SP).weekday, 0, 'domingo');
    // Aceita ISO e Date além de ms.
    assert.equal(schoolTime.schoolDateOf('2026-11-19T02:30:00.000Z', SP), '2026-11-18');
    assert.equal(schoolTime.schoolDateOf(new Date(at), SP), '2026-11-18');
});

test('[UC-HORARIO-001] sem fuso vale o das configurações (o mesmo dia de settings.todayInTz)', () => {
    const before = db.memory.config;
    try {
        db.memory.config = { ...(before || {}), settings: { timezone: 'Asia/Tokyo' } };
        assert.equal(schoolTime.schoolTimezone(), 'Asia/Tokyo');
        assert.equal(schoolTime.schoolDateOf(Date.now()), settingsUtil.todayInTz('Asia/Tokyo'));
        assert.equal(schoolTime.schoolDateOf(Date.UTC(2026, 10, 18, 16)), '2026-11-19');
        assert.equal(iso(schoolTime.deadlineFromLocal('2026-11-19', '01:00')), '2026-11-18T16:00:00.000Z');
        // Fuso gravado que o Intl não conhece (backup antigo): vale o padrão da escola.
        db.memory.config = { ...(before || {}), settings: { timezone: 'Brasil/Hora' } };
        assert.equal(schoolTime.schoolTimezone(), SP);
        assert.equal(schoolTime.schoolDateOf(Date.now()), settingsUtil.today());
        assert.equal(schoolTime.schoolTimezone('Europe/Lisbon'), 'Europe/Lisbon');
        assert.equal(schoolTime.schoolTimezone('Nada/Nenhum'), SP);
    } finally {
        db.memory.config = before;
    }
});
