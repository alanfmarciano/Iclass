// Conversas do modo de demonstração (fase 3, C14 / P5-S7b, FUN-14; conferências ao vivo
// do P5: "o seed ganha duas conversas, uma encerrada").
// [UC-MENSAGEM-006] POST /api/test/seed põe na turma 1DES a conversa aberta da Alice (com a
// última mensagem do professor ainda não lida: o sino e o contador do portal mostram 1) e
// a do Bruno, encerrada pelo professor; as duas abrem pelas rotas do portal e do painel
// como qualquer conversa, e um seed de novo refaz só as do seed, sem as respostas escritas nelas (as conversas
// criadas pela tela ficam).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-conversas-seed-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const conversations = require('../../backend/utils/conversations.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso_legacy_01';
const CLASS = '1DES';
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;
let app;

test.before(async () => {
    await db.init();
    app = createApp();
});
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const seedRows = () => ({
    conversas: (db.memory.conversations || []).filter(conv => String(conv.id).startsWith('seed_conv_')),
    mensagens: (db.memory.conversationMessages || []).filter(msg => String(msg.id).startsWith('seed_msg_')),
});

test('[UC-MENSAGEM-006] o seed traz duas conversas na 1DES: a da Alice aberta com uma mensagem nova e a do Bruno encerrada', async () => {
    const seeded = await request(app).post('/api/test/seed');
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    assert.equal(seeded.body.demo.conversations, 2);
    const { conversas, mensagens } = seedRows();
    assert.equal(conversas.length, 2);
    assert.equal(mensagens.length, 6);
    // Linhas completas no formato das gravadas pela tela (lidas com os padrões, iguais).
    conversas.forEach(conv => {
        const read = conversations.readConversation(conv);
        assert.equal(read.mensagens, mensagens.filter(msg => msg.conversationId === conv.id).length);
        assert.equal(read.ultimaMensagemEm, Math.max(...mensagens.filter(msg => msg.conversationId === conv.id).map(msg => msg.criadaEm)));
        assert.equal(conv.schemaVersion, 1);
        assert.ok(conv.aluno.studentId && conv.aluno.studentId.startsWith('alu_'), 'studentId ao lado do e-mail');
    });

    const alice = createStudentSession(db.memory, 'aluno@teste.local');
    const list = await request(app).get(`/api/student/conversations?${Q}`).set('x-session-token', alice);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.conversas.length, 1);
    assert.equal(list.body.conversas[0].assunto, 'Revisão da prova');
    assert.equal(list.body.conversas[0].naoLidas, 1);
    assert.equal(list.body.conversas[0].instrutor.nome, 'Paulo Professor');
    assert.equal(list.body.aviso, 'O administrador da escola pode ler estas mensagens.');
    const bell = await request(app).get(`/api/student/notifications?${Q}`).set('x-session-token', alice);
    assert.equal(bell.status, 200);
    const item = bell.body.items.find(entry => entry.type === 'mensagem');
    assert.ok(item, 'mensagem no sino');
    assert.equal(item.href, '/aluno/mensagens?c=seed_conv_alice');
    const thread = await request(app).get('/api/student/conversations/seed_conv_alice/messages').set('x-session-token', alice);
    assert.equal(thread.status, 200);
    assert.deepEqual(thread.body.mensagens.map(msg => msg.autor), ['voce', 'instrutor', 'instrutor']);
    assert.match(thread.body.mensagens[2].texto, /\n/, 'a quebra de linha vai como está');

    const prof = createAdminSession(db.memory, 'professor@teste.local');
    const closed = await request(app).get(`/api/admin/conversations?${Q}&status=encerrada`).set('x-admin-session', prof);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(closed.body.conversas.map(row => [row.aluno.nome, row.status, row.motivoEncerramento]), [['Bruno Souza', 'encerrada', 'Assunto resolvido']]);
    const open = await request(app).get(`/api/admin/conversations?${Q}&status=aberta`).set('x-admin-session', prof);
    assert.deepEqual(open.body.conversas.map(row => [row.aluno.nome, row.naoLidas]), [['Alice Aluna', 0]]);
});

test('[UC-MENSAGEM-006] seed de novo refaz só as conversas do seed (sem as respostas escritas nelas); a conversa criada pela tela fica', async () => {
    await request(app).post('/api/test/seed');
    const prof = createAdminSession(db.memory, 'professor@teste.local');
    const reply = await request(app).post('/api/admin/conversations/seed_conv_alice/messages').set('x-admin-session', prof).send({ texto: 'Mais alguma dúvida?' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const started = await request(app).post('/api/admin/conversations').set('x-admin-session', prof)
        .send({ courseId: COURSE, studentClass: CLASS, studentEmail: 'carla.mendes@teste.local', assunto: 'Projeto', texto: 'Oi, Carla.' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    await request(app).post('/api/test/seed');
    const { conversas, mensagens } = seedRows();
    assert.equal(conversas.length, 2);
    assert.equal(mensagens.length, 6);
    assert.ok((db.memory.conversations || []).some(conv => conv.id === started.body.conversa.id), 'a conversa da tela continua');
    assert.ok((db.memory.conversationMessages || []).some(msg => msg.conversationId === started.body.conversa.id), 'a mensagem dela também');
    // A conversa do seed volta ao estado do seed, sem a resposta escrita nela (a contagem bate).
    assert.ok(!(db.memory.conversationMessages || []).some(msg => msg.id === reply.body.mensagem.id));
    const alice = conversas.find(conv => conv.id === 'seed_conv_alice');
    assert.equal(conversations.readConversation(alice).mensagens, 3);
    assert.equal(conversations.messagesOf(db.memory, 'seed_conv_alice').length, 3);
});
