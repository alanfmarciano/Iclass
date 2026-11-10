// Família de uma prova (G2, gabarito na reaplicação): a prova do curso e as variantes
// "só desta turma" criadas ao editar a prova com escopo turma (forkEvaluation em
// utils/classContent.js cria Avaliacao_X__turma_<hash> com sourceEvaluationKey = X e
// copia o Gabarito_X para a variante). As provas da família têm as mesmas respostas
// (ou quase), então a trava do gabarito numa nova aplicação e a máscara do gabarito
// para o aluno valem para a família inteira, não só para a chave exata.
// Os vínculos vêm do que já fica gravado (nada a migrar): sourceEvaluationKey das
// avaliações e o mapa de variantes de cada turma (contentOverrides.evaluations).
function examFamilyIndex(memory) {
    const neighbors = new Map();
    const link = (a, b) => {
        const left = String(a || '').trim();
        const right = String(b || '').trim();
        if (!left || !right || left === right) return;
        if (!neighbors.has(left)) neighbors.set(left, new Set());
        if (!neighbors.has(right)) neighbors.set(right, new Set());
        neighbors.get(left).add(right);
        neighbors.get(right).add(left);
    };
    Object.entries(memory?.evaluations || {}).forEach(([key, evaluation]) => {
        if (evaluation && typeof evaluation === 'object') link(key, evaluation.sourceEvaluationKey);
    });
    (Array.isArray(memory?.classes) ? memory.classes : []).forEach(cls => {
        Object.entries(cls?.contentOverrides?.evaluations || {}).forEach(([baseKey, entry]) => {
            link(baseKey, typeof entry === 'string' ? entry : entry?.key);
        });
    });

    const cache = new Map();
    return function familyOf(examKey) {
        const start = String(examKey || '').trim();
        if (!start) return new Set();
        if (cache.has(start)) return cache.get(start);
        const family = new Set([start]);
        const queue = [start];
        while (queue.length) {
            const current = queue.shift();
            (neighbors.get(current) || []).forEach(next => {
                if (family.has(next)) return;
                family.add(next);
                queue.push(next);
            });
        }
        family.forEach(key => cache.set(key, family));
        return family;
    };
}

function examFamilyKeys(memory, examKey) {
    return examFamilyIndex(memory)(examKey);
}

module.exports = { examFamilyIndex, examFamilyKeys };
