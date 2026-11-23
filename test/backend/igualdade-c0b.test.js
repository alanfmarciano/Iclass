// Teste de igualdade da fundação C0b (fase 3; K13, K14 e X8 do plano): o sino e o
// calendário do aluno, a fila "Precisa de você" e o sino do instrutor, Meus dados (aluno
// e administrador), Cadastros encerrados, a troca de e-mail, o anonimizar e o apagar de
// vez continuam dando a saída de hoje depois que passaram a percorrer os provedores
// (utils/studentFeeds.js) e os handlers (utils/studentDataHandlers.js).
//
// fixtures/igualdade-c0b.json é a saída do código de antes do C0b (222dcae), gerada por
// fixtures/igualdade-c0b.js numa cópia daquele código (git archive 222dcae). O teste
// roda o mesmo gerador no código de agora, sem nada registrado e com provedores e
// handlers que não acrescentam nada, e compara. Na J0 o gerador ganhou um pedido de
// matrícula pendente (o item Matrículas da fila) e a cópia foi gerada de novo, no 222dcae
// e no 281029f (o main de antes da fase 3): as duas saídas são iguais byte a byte, então
// a comparação vale também contra o código que o Alan tem hoje.
//
// Diferença de propósito: a subetapa que muda a saída de hoje acrescenta o caminho em
// DIFERENCAS_ESPERADAS, com o motivo ('*' vale um nível; '**' no fim vale o resto). O
// B16 marca aqui a do certificado no 'apagar de vez' (X8: o registro fica, sem dado
// pessoal).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');
const GENERATOR = path.join(__dirname, 'fixtures/igualdade-c0b.js');
const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/igualdade-c0b.json'), 'utf8'));

// { caminho, motivo }
const DIFERENCAS_ESPERADAS = [
    {
        // fila.2 é o item Matrículas (o teste de baixo confere que é ele e os dois textos).
        caminho: 'fila.2.detalhe',
        motivo: 'B0b (P4-S1): a Secretaria passou a ver e aprovar matrículas, e o texto '
            + '"visível apenas para administrador" deixou de ser verdade; vale o do sino, "aguardando aprovação".',
    },
    {
        // 'modelo-2026.1:termos|...' passou a 'modelo-2026.2:termos|...'.
        caminho: 'sinoAluno.body.legalVersion',
        motivo: 'A10 (P3-S13): o texto do modelo dos Termos e da Política mudou (IP e aparelho do login '
            + 'durante a prova), e o identificador do modelo muda junto (MODEL_ID em legalTemplates.js).',
    },
    // C10 (P1-h): as entregas de tarefa registram o handler 'assignmentSubmissions' com
    // contagem ("Trabalhos entregues"). Cadastros encerrados, a resposta e a auditoria do
    // anonimizar e do apagar ganham a contagem nova (0 aqui: o gerador não tem tarefa) e a
    // rota de Cadastros encerrados ganha countLabels com o nome dela. O teste de baixo
    // confere os valores.
    ...[
        'encerrados.*.counts.assignmentSubmissions',
        'encerradosRota.body.items.*.counts.assignmentSubmissions',
        'encerradosRota.body.countLabels',
        'anonimizar.body.kept.assignmentSubmissions',
        'memoriaDepoisDeAnonimizar.auditLogs.*.details.kept.assignmentSubmissions',
        'apagar.body.removed.assignmentSubmissions',
        'memoriaDepoisDeApagar.auditLogs.*.details.kept.assignmentSubmissions',
        'memoriaDepoisDeApagar.auditLogs.*.details.removed.assignmentSubmissions',
        'encerradosDepois.*.counts.assignmentSubmissions',
    ].map(caminho => ({ caminho, motivo: 'C10 (P1-h): contagem "Trabalhos entregues" do handler das entregas de tarefa.' })),
    // C12 (P5-S4): os grupos de alunos registram o handler 'classGroups' com contagem
    // ("Grupos de alunos"), nos mesmos lugares (0 aqui: o gerador não tem grupo).
    ...[
        'encerrados.*.counts.classGroups',
        'encerradosRota.body.items.*.counts.classGroups',
        'anonimizar.body.kept.classGroups',
        'memoriaDepoisDeAnonimizar.auditLogs.*.details.kept.classGroups',
        'apagar.body.removed.classGroups',
        'memoriaDepoisDeApagar.auditLogs.*.details.kept.classGroups',
        'memoriaDepoisDeApagar.auditLogs.*.details.removed.classGroups',
        'encerradosDepois.*.counts.classGroups',
    ].map(caminho => ({ caminho, motivo: 'C12 (P5-S4): contagem "Grupos de alunos" do handler dos grupos.' })),
    // C13 (P5-S7a): as conversas com professores registram o handler 'conversations' com
    // contagem ("Conversas com professores"), nos mesmos lugares (0 aqui: o gerador não
    // tem conversa).
    ...[
        'encerrados.*.counts.conversations',
        'encerradosRota.body.items.*.counts.conversations',
        'anonimizar.body.kept.conversations',
        'memoriaDepoisDeAnonimizar.auditLogs.*.details.kept.conversations',
        'apagar.body.removed.conversations',
        'memoriaDepoisDeApagar.auditLogs.*.details.kept.conversations',
        'memoriaDepoisDeApagar.auditLogs.*.details.removed.conversations',
        'encerradosDepois.*.counts.conversations',
    ].map(caminho => ({ caminho, motivo: 'C13 (P5-S7a): contagem "Conversas com professores" do handler das conversas.' })),
    // B10 (P2-S9): o histórico de matrícula registra o handler 'historicoMatriculas' com
    // contagem ("Histórico de matrículas"), nos mesmos lugares (0 aqui: os alunos do gerador
    // já nascem encerrados, sem histórico gravado). O teste de baixo confere os valores.
    ...[
        'encerrados.*.counts.historicoMatriculas',
        'encerradosRota.body.items.*.counts.historicoMatriculas',
        'anonimizar.body.kept.historicoMatriculas',
        'memoriaDepoisDeAnonimizar.auditLogs.*.details.kept.historicoMatriculas',
        'apagar.body.removed.historicoMatriculas',
        'memoriaDepoisDeApagar.auditLogs.*.details.kept.historicoMatriculas',
        'memoriaDepoisDeApagar.auditLogs.*.details.removed.historicoMatriculas',
        'encerradosDepois.*.counts.historicoMatriculas',
    ].map(caminho => ({ caminho, motivo: 'B10 (P2-S9): contagem "Histórico de matrículas" do handler do histórico de matrícula.' })),
    // C14 (P5-S7b, revisão): o sino do aluno e o do painel mandam mensagensNovas (conversas
    // com mensagem nova, contadas antes do corte da lista), para o número do menu
    // Mensagens. Campo novo; os itens e o unread continuam os de antes (0 aqui: o gerador
    // não tem conversa).
    ...['sinoAluno.body.mensagensNovas', 'sinoInstrutor.body.mensagensNovas']
        .map(caminho => ({ caminho, motivo: 'C14 (P5-S7b): mensagensNovas no sino para o contador do menu Mensagens.' })),
];

function run(env = {}) {
    const result = spawnSync(process.execPath, [GENERATOR, ROOT], {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env },
    });
    assert.equal(result.status, 0, `o gerador falhou:\n${result.stderr}`);
    return { output: JSON.parse(result.stdout), stderr: result.stderr };
}

// Caminhos ('a.b.0.c') onde as duas saídas diferem.
function differences(before, after, base = '', out = []) {
    const isObject = value => value && typeof value === 'object';
    if (!isObject(before) || !isObject(after) || Array.isArray(before) !== Array.isArray(after)) {
        if (!Object.is(before, after)) out.push(base || '(raiz)');
        return out;
    }
    const keys = Array.isArray(before)
        ? Array.from({ length: Math.max(before.length, after.length) }, (_, index) => String(index))
        : [...new Set([...Object.keys(before), ...Object.keys(after)])];
    keys.forEach(key => {
        const next = base ? `${base}.${key}` : key;
        if (!(key in before) || !(key in after)) out.push(next);
        else differences(before[key], after[key], next, out);
    });
    // Ordem das chaves também é saída (o JSON baixado em Meus dados, a resposta da API).
    if (!Array.isArray(before) && Object.keys(before).join('|') !== Object.keys(after).join('|')
        && Object.keys(before).length === Object.keys(after).length) out.push(`${base || '(raiz)'}:ordem`);
    return out;
}

function expected(pathText) {
    return DIFERENCAS_ESPERADAS.some(({ caminho }) => {
        const pattern = caminho.split('.');
        const parts = pathText.split('.');
        for (let i = 0; i < pattern.length; i++) {
            if (pattern[i] === '**') return true;
            if (i >= parts.length || (pattern[i] !== '*' && pattern[i] !== parts[i])) return false;
        }
        return pattern.length === parts.length;
    });
}

test('[UC-FUNDACAO-002] sem provedor nem handler, a saída é a de antes do C0b', () => {
    const { output } = run();
    const found = differences(BEFORE, output).filter(item => !expected(item));
    assert.deepEqual(found, [], 'saída diferente da de antes');
});

test('[UC-FUNDACAO-002] com provedores e handlers que não acrescentam nada, a saída continua a de antes e os handlers são chamados', () => {
    const { output, stderr } = run({ ICLASS_IGUALDADE_COM_REGISTROS: '1' });
    const found = differences(BEFORE, output).filter(item => !expected(item));
    assert.deepEqual(found, [], 'saída diferente da de antes');
    const line = stderr.split('\n').find(item => item.startsWith('chamadas dos handlers: '));
    assert.ok(line, stderr);
    const calls = JSON.parse(line.slice('chamadas dos handlers: '.length));
    assert.deepEqual(calls.map(call => call[0]), ['rename', 'anonymize', 'purge']);
    assert.deepEqual(calls[0], ['rename', 'duda@igualdade.local', 'duda.nova@igualdade.local']);
    assert.equal(calls[1][1], 'bia@igualdade.local');
    assert.match(calls[1][2], /^anonimizado-[0-9a-f]{12}@anonimizado\.invalid$/);
    assert.deepEqual(calls[2], ['purge', 'caio@igualdade.local']);
});

test('[UC-FUNDACAO-002] fila: a única diferença da de antes é o texto do item Matrículas, igual ao do sino', () => {
    const { output } = run();
    const before = BEFORE.fila[2];
    const after = output.fila[2];
    assert.equal(before.id, 'matriculas');
    assert.equal(before.detalhe, 'visível apenas para administrador · Matrículas');
    assert.equal(after.detalhe, 'aguardando aprovação · Matrículas');
    // Fora o texto, o item é o mesmo (contagem só do pedido pendente, destino e permissão).
    assert.deepEqual({ ...after, detalhe: before.detalhe }, before);
    assert.equal(before.count, 1);
    // A diferença marcada vale só para este caminho: o resto da fila é igual.
    assert.deepEqual(differences(BEFORE.fila, output.fila), ['2.detalhe']);
    assert.equal(expected('fila.1.detalhe'), false);
    assert.equal(expected('fila.2.titulo'), false);
});

test('[UC-FUNDACAO-002] C10: a contagem nova das entregas de tarefa é 0 sem tarefa e tem o nome "Trabalhos entregues"', () => {
    const { output } = run();
    const values = [];
    const walk = (value, pathText) => {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(key => {
            const next = pathText ? `${pathText}.${key}` : key;
            if (key === 'assignmentSubmissions' && /\.(counts|kept|removed)\.assignmentSubmissions$/.test(next)) values.push([next, value[key]]);
            else walk(value[key], next);
        });
    };
    walk(output, '');
    assert.ok(values.length >= 9, JSON.stringify(values));
    values.forEach(([where, value]) => assert.equal(value, 0, where));
    assert.equal(output.encerradosRota.body.countLabels.assignmentSubmissions, 'Trabalhos entregues');
    // Fora da contagem, Meus dados continua o de antes (sem entrega, sem seção nova).
    assert.equal('tarefas' in output.meusDadosAluno, false);
    assert.equal('tarefas' in output.meusDadosAdmin, false);
});

test('[UC-FUNDACAO-002] C12: a contagem nova dos grupos de alunos é 0 sem grupo e tem o nome "Grupos de alunos"', () => {
    const { output } = run();
    const values = [];
    const walk = (value, pathText) => {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(key => {
            const next = pathText ? `${pathText}.${key}` : key;
            if (key === 'classGroups' && /\.(counts|kept|removed)\.classGroups$/.test(next)) values.push([next, value[key]]);
            else walk(value[key], next);
        });
    };
    walk(output, '');
    assert.ok(values.length >= 9, JSON.stringify(values));
    values.forEach(([where, value]) => assert.equal(value, 0, where));
    assert.equal(output.encerradosRota.body.countLabels.classGroups, 'Grupos de alunos');
    // Sem grupo, Meus dados continua o de antes (sem seção nova).
    assert.equal('grupos' in output.meusDadosAluno, false);
    assert.equal('grupos' in output.meusDadosAdmin, false);
});

test('[UC-FUNDACAO-002] C13: a contagem nova das conversas é 0 sem conversa e tem o nome "Conversas com professores"', () => {
    const { output } = run();
    const values = [];
    const walk = (value, pathText) => {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(key => {
            const next = pathText ? `${pathText}.${key}` : key;
            if (key === 'conversations' && /\.(counts|kept|removed)\.conversations$/.test(next)) values.push([next, value[key]]);
            else walk(value[key], next);
        });
    };
    walk(output, '');
    assert.ok(values.length >= 9, JSON.stringify(values));
    values.forEach(([where, value]) => assert.equal(value, 0, where));
    // B10 (P2-S9): o histórico de matrícula também tem contagem (o teste de baixo).
    assert.deepEqual(output.encerradosRota.body.countLabels, { assignmentSubmissions: 'Trabalhos entregues', classGroups: 'Grupos de alunos', conversations: 'Conversas com professores', historicoMatriculas: 'Histórico de matrículas' });
    // Sem conversa, Meus dados continua o de antes (sem seção nova).
    assert.equal('conversas' in output.meusDadosAluno, false);
    assert.equal('conversas' in output.meusDadosAdmin, false);
});

test('[UC-MATRICULA-002] B10: a contagem nova do histórico de matrícula é 0 sem histórico e tem o nome "Histórico de matrículas"', () => {
    const { output } = run();
    const values = [];
    const walk = (value, pathText) => {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(key => {
            const next = pathText ? `${pathText}.${key}` : key;
            if (key === 'historicoMatriculas' && /\.(counts|kept|removed)\.historicoMatriculas$/.test(next)) values.push([next, value[key]]);
            else walk(value[key], next);
        });
    };
    walk(output, '');
    assert.ok(values.length >= 9, JSON.stringify(values));
    values.forEach(([where, value]) => assert.equal(value, 0, where));
    assert.equal(output.encerradosRota.body.countLabels.historicoMatriculas, 'Histórico de matrículas');
    // Sem histórico, Meus dados continua o de antes (sem seção nova).
    assert.equal('enrollmentHistory' in output.meusDadosAluno, false);
    assert.equal('enrollmentHistory' in output.meusDadosAdmin, false);
});

test('o comparador acha diferença de valor, de chave e de ordem (não ficou cego)', () => {
    assert.deepEqual(differences({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
    assert.deepEqual(differences({ a: 1, b: [1, 2] }, { a: 2, b: [1] }), ['a', 'b.1']);
    assert.deepEqual(differences({ a: 1 }, { a: 1, c: 1 }), ['c']);
    assert.deepEqual(differences({ a: 1, b: 2 }, { b: 2, a: 1 }), ['(raiz):ordem']);
    // A cópia de antes tem o que o teste precisa olhar (não é um arquivo vazio).
    ['sinoAluno', 'calendarioAluno', 'fila', 'sinoInstrutor', 'meusDadosAluno', 'meusDadosAdmin', 'encerrados', 'trocaEmail', 'anonimizar', 'apagar', 'memoriaDepoisDeApagar']
        .forEach(key => assert.ok(BEFORE[key], key));
    assert.ok(BEFORE.sinoAluno.body.items.length >= 4);
    assert.ok(BEFORE.fila.length >= 4);
    assert.equal(BEFORE.anonimizar.status, 200);
    assert.equal(BEFORE.apagar.status, 200);
    assert.equal(BEFORE.trocaEmail.status, 200);
});
