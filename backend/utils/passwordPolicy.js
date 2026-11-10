// Política de senha (H5a; SEG-06, UXA-13): a única regra que decide se uma senha NOVA
// pode ser gravada. Antes, o cadastro, a criação pelo professor e o "Resetar senha"
// aceitavam a senha "1".
//
// validateNewPassword(senha, { kind, email, name, nomeSocial, matricula }) devolve
// { ok: true } ou { ok: false, error }, com a mensagem em português para a tela.
// - kind 'student' (aluno, mínimo de 8 caracteres) ou 'instructor' (administrador e
//   professor, mínimo de 10, como já era a troca de senha do instrutor);
// - o valor é avaliado com trim(), a mesma regra da gravação e da conferência da senha
//   (quem digitou um espaço no fim continua entrando);
// - nesta ordem: tamanho mínimo; tamanho máximo (128); senha comum, um caractere
//   repetido ou sequência simples (12345678, abcdefgh, 87654321); igual ao e-mail, ao
//   nome, ao nome social ou à matrícula, contendo a parte do e-mail antes do @
//   (quando ela tem 4 caracteres ou mais) ou feita de um nome só, com números e
//   símbolos em volta (sofia123, Tiago@2010).
//
// Só senha digitada passa por aqui: a senha temporária gerada pelo servidor
// (generateTemporaryPassword) já nasce aleatória. As senhas já gravadas não são
// revalidadas na gravação; o login confere a senha digitada (isWeakPassword) para
// pedir a troca de quem ainda usa uma senha fraca (decisão P3 do Alan).
//
// A lista de senhas comuns fica só aqui: a tela (web/src/lib/passwordPolicy.js) mostra
// apenas o tamanho mínimo e a dica, e quem decide é o servidor.

const crypto = require('crypto');

const MIN_LENGTH = Object.freeze({ student: 8, instructor: 10 });
const MAX_LENGTH = 128;

// Senhas comuns em português e inglês, as que aparecem em vazamentos e as óbvias de
// escola (nome do sistema, da instituição, "aluno", "professor"). Comparadas em
// minúsculas; as de menos de 8 caracteres já caem pelo tamanho e não precisam estar aqui.
const COMMON_PASSWORDS = new Set([
    '12345678', '123456789', '1234567890', '12345678910', '0123456789', '87654321', '987654321',
    '11111111', '00000000', '12341234', '12121212', '11223344', '123123123', '147258369',
    '159753123', '123456123', '123qweasd', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'qwe12345',
    'qwerty12', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'abc12345',
    'abc123456', 'abcd1234', 'aa123456', 'a1b2c3d4', 'password', 'password1', 'password12',
    'password123', 'passw0rd', 'p@ssw0rd', 'iloveyou', 'sunshine', 'princess', 'football',
    'baseball', 'superman', 'whatever', 'trustno1', 'welcome1', 'letmein1', 'master12',
    'dragon12', 'monkey12', 'senha123', 'senha1234', 'senha12345', 'senha123456', 'minhasenha',
    'minhasenha1', 'minhasenha123', 'novasenha', 'novasenha1', 'novasenha123', 'senhasenha',
    'senhanova', 'mudar123', 'mudar1234', 'mudarsenha', 'trocar123', 'trocar1234', 'trocarsenha',
    'temporaria', 'provisoria', 'iclass123', 'iclass1234', 'iclassv3', 'iclass2024', 'iclass2025',
    'iclass2026', 'senai123', 'senai1234', 'senai2023', 'senai2024', 'senai2025', 'senai2026',
    'sesi1234', 'senac123', 'senac1234', 'etec1234', 'escola123', 'escola1234', 'colegio123',
    'aluno123', 'aluno1234', 'aluno12345', 'alunos123', 'estudante', 'estudante1', 'estudante123',
    'professor', 'professor1', 'professor123', 'professora', 'admin123', 'admin1234', 'admin12345',
    'administrador', 'administrator', 'brasil123', 'brasil1234', 'brasil2024', 'brasil2025',
    'flamengo', 'flamengo1', 'flamengo123', 'corinthians', 'palmeiras', 'saopaulo', 'vasco123',
    'gremio123', 'santos123', 'cruzeiro', 'botafogo', 'internacional', 'mengao123', 'jesus123',
    'jesuscristo', 'deusefiel', 'deusmeama', 'amor1234', 'amorzinho', 'teamo123',
    'familia123', 'felicidade', 'liberdade', 'computador', 'computer1', 'internet', 'internet1',
    'informatica', 'tecnologia', 'desenvolvimento', 'programador', 'qualquer1', 'qualquercoisa',
    'naosei123', 'testando', 'teste123', 'teste1234', 'teste12345', 'testeteste', 'abcdefgh1',
]);

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

// Só letras e números, sem acento e em minúsculas: "Ana Souza", "ana.souza" e "anasouza"
// ficam iguais na comparação com os dados pessoais.
function compactText(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

// Um único caractere repetido (aaaaaaaa, 11111111).
function isRepeatedCharacter(text) {
    return text.length > 0 && [...text].every(char => char === text[0]);
}

// Sequência simples, crescente ou decrescente, só de dígitos ou só de letras
// (12345678, 98765432, abcdefgh, hgfedcba). Os dígitos podem passar de 9 para 0
// (78901234), como no teclado.
function isSimpleSequence(text) {
    if (text.length < 3) return false;
    const digits = /^[0-9]+$/.test(text);
    if (!digits && !/^[a-z]+$/.test(text)) return false;
    const codes = [...text].map(char => char.charCodeAt(0));
    const stepOf = (a, b) => (digits ? ((b - a + 10) % 10) : b - a);
    const ascending = codes.every((code, i) => i === 0 || stepOf(codes[i - 1], code) === 1);
    const descending = codes.every((code, i) => i === 0 || stepOf(code, codes[i - 1]) === 1);
    return ascending || descending;
}

function isCommonPassword(value) {
    const lower = String(value).toLowerCase();
    return COMMON_PASSWORDS.has(lower) || isRepeatedCharacter(lower) || isSimpleSequence(lower);
}

// Palavras do nome, do nome social e da parte do e-mail antes do @ (3 letras ou mais):
// "Sofia Conceição" e "sofia.conceicao@..." dão "sofia" e "conceicao".
function personalWords({ email, name, nomeSocial } = {}) {
    const words = [name, nomeSocial, String(email || '').split('@')[0]]
        .flatMap(value => normalizeText(value).split(/[^a-z]+/));
    return new Set(words.filter(word => word.length >= 3));
}

// Igual a um dado pessoal da conta (só letras e números, sem acento, em minúsculas),
// contendo a parte do e-mail antes do @, quando ela tem 4 caracteres ou mais, ou feita
// de um nome só com números e símbolos em volta (sofia123, Tiago@2010).
function matchesPersonalData(value, { email, name, nomeSocial, matricula } = {}) {
    const candidate = compactText(value);
    if (!candidate) return false;
    const personal = [email, name, nomeSocial, matricula].map(compactText).filter(Boolean);
    if (personal.includes(candidate)) return true;
    const localPart = compactText(String(email || '').split('@')[0]);
    if (localPart.length >= 4 && candidate.includes(localPart)) return true;
    const letters = normalizeText(value).replace(/[^a-z]+/g, '');
    return !!letters && personalWords({ email, name, nomeSocial }).has(letters);
}

function passwordMinLength(kind) {
    return kind === 'instructor' ? MIN_LENGTH.instructor : MIN_LENGTH.student;
}

function validateNewPassword(password, options = {}) {
    const kind = options.kind === 'instructor' ? 'instructor' : 'student';
    const value = typeof password === 'string' ? password.trim() : '';
    const min = passwordMinLength(kind);
    if (value.length < min) return { ok: false, error: `A senha precisa ter pelo menos ${min} caracteres.` };
    if (value.length > MAX_LENGTH) return { ok: false, error: `A senha pode ter no máximo ${MAX_LENGTH} caracteres.` };
    if (isCommonPassword(value)) return { ok: false, error: 'Essa senha é muito comum. Escolha outra.' };
    if (matchesPersonalData(value, options)) {
        return { ok: false, error: 'A senha não pode ser igual ao seu e-mail, nome ou matrícula.' };
    }
    return { ok: true };
}

// Resposta 400 de senha recusada pela política (formato único das rotas).
function passwordPolicyRefusal(result) {
    // Formato dos 400 combinado entre os grupos: { success: false, error, field }.
    return { success: false, error: result.error, passwordPolicy: true, field: 'password' };
}

// A senha digitada no login seria recusada hoje? (troca obrigatória da senha fraca.)
function isWeakPassword(password, options = {}) {
    return !validateNewPassword(password, options).ok;
}

// Senha temporária gerada pelo servidor: 10 letras e números sem os que se confundem
// (0/o, 1/l/i), no formato xxxxx-xxxxx, fácil de ditar e de digitar no celular.
const TEMPORARY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateTemporaryPassword() {
    const pick = () => TEMPORARY_ALPHABET[crypto.randomInt(TEMPORARY_ALPHABET.length)];
    const block = () => Array.from({ length: 5 }, pick).join('');
    return `${block()}-${block()}`;
}

module.exports = {
    COMMON_PASSWORDS,
    MAX_LENGTH,
    MIN_LENGTH,
    TEMPORARY_ALPHABET,
    generateTemporaryPassword,
    isCommonPassword,
    isWeakPassword,
    passwordMinLength,
    passwordPolicyRefusal,
    validateNewPassword,
};
