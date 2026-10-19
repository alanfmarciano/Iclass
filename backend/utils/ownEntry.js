// Leitura de mapa em memória (sessões de instrutor e de aluno, liberações por aluno,
// anotações) por uma chave que vem do pedido (cabeçalho, query, corpo).
// `mapa[chave]` devolve também o que todo objeto herda de Object.prototype: com a chave
// '__proto__', 'constructor', 'toString', 'hasOwnProperty' ou 'valueOf' o valor herdado
// (um objeto ou uma função) contava como sessão de instrutor válida, sem login.
// Só vale a chave própria do mapa, em texto não vazio.
function ownEntry(map, key) {
    if (!map || typeof map !== 'object') return undefined;
    if (typeof key !== 'string' || !key) return undefined;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// Nome que todo objeto herda (inclusive '__proto__'). Não pode virar chave de mapa
// gravado a partir do pedido: `mapa['__proto__'][x] = v` grava em Object.prototype, e
// isso vale para todos os objetos do servidor até ele reiniciar.
function isInheritedKey(key) {
    return String(key) in Object.prototype;
}

module.exports = { ownEntry, isInheritedKey };
