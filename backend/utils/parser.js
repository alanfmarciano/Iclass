// Leitura das avaliações antigas em Markdown (content/<prova>.md): título, tema,
// rubrica, gabarito dentro de <details> e questões de múltipla escolha.
//
// Alternativas e gabarito vão de a) a e) (antes só a-d: a alternativa e) entrava
// colada no texto da d) e o gabarito "E" sumia). Letra depois de e) não é aceita:
// a alternativa fica de fora, mas nunca em silêncio. Cada recusa vira um aviso em
// português, devolvido por parseEvaluationMarkdownWithWarnings (registro do boot e
// tela de Provas, a cada abertura enquanto a prova não for salva no editor, por
// importWarningsFor). Também avisa a questão que fica de fora por ter menos de duas
// alternativas reconhecidas.
const LETRAS_ACEITAS = 'ABCDE';
const ULTIMA_LETRA = LETRAS_ACEITAS[LETRAS_ACEITAS.length - 1];

// Início de uma alternativa: a letra minúscula e o parêntese no começo da linha
// ("a) texto"), com marcador de lista ("- a) texto") ou negrito ("**a)** texto",
// "**a) texto**") opcionais. Qualquer letra é reconhecida aqui para que a f) não se
// cole no texto da e); quem decide se ela vale é LETRAS_ACEITAS. Grupos: 2 = negrito
// que abre antes da letra, 3 = letra, 4 = negrito que fecha logo depois de "a)".
const INICIO_ALTERNATIVA = /(^|\n)[ \t]*(?:[-*+][ \t]+)?(\*\*|__)?([a-z])\)(\*\*|__)?[ \t]*/g;
// Uma alternativa escrita dentro do texto de outra (mesmo começo de linha que acima):
// é o que a versão antiga (só a-d) gravava quando a prova tinha e).
const ALTERNATIVA_COLADA = /(?:^|\n)[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?([a-z])\)/;
// Fim do texto da última alternativa: separador, próxima questão, título ou HTML.
const FIM_DO_BLOCO = /\n---|\n\*\*|\n##|\n</;

function letraAceita(letra) {
    return LETRAS_ACEITAS.includes(String(letra || '').toUpperCase());
}

// Gabarito como está escrito (letra maiúscula por número de questão), ainda sem
// conferir a letra: a recusa (com aviso) é feita na questão, para que um "2. O" de
// uma observação dentro do <details> não vire aviso de questão que não existe.
function lerGabarito(markdownText) {
    const gabarito = {};
    const detailsMatch = markdownText.match(/<details>([\s\S]*?)<\/details>/);
    if (!detailsMatch) return gabarito;
    const detailsContent = detailsMatch[1];
    // Detalhado: "1. **C**". Compacto: "1. C" (só quando não há o detalhado).
    const detalhado = [...detailsContent.matchAll(/(\d+)\.\s*\*\*([A-Za-z])\*\*/g)];
    const marcas = detalhado.length ? detalhado : [...detailsContent.matchAll(/(\d+)\.\s*([A-Za-z])\b/g)];
    // Por número, vale a primeira letra aceita (de A a E); um texto livre depois do
    // gabarito ("Nota: a questão 2. O enunciado...") não apaga o "2. C" que veio antes.
    // Sem nenhuma letra aceita, fica a primeira escrita, para a questão avisar a recusa.
    marcas.forEach(m => {
        const numero = parseInt(m[1], 10);
        const letra = m[2].toUpperCase();
        const atual = gabarito[numero];
        if (atual === undefined || (!letraAceita(atual) && letraAceita(letra))) gabarito[numero] = letra;
    });
    return gabarito;
}

function lerAlternativas(bloco, numero, avisos) {
    const marcas = [...bloco.matchAll(INICIO_ALTERNATIVA)];
    const alternativas = [];
    marcas.forEach((marca, index) => {
        const inicio = marca.index + marca[0].length;
        const proxima = index + 1 < marcas.length ? marcas[index + 1].index : bloco.length;
        let texto = bloco.slice(inicio, proxima);
        // A última alternativa termina no separador ou no começo de outro bloco.
        const fim = texto.search(FIM_DO_BLOCO);
        if (fim >= 0) texto = texto.slice(0, fim);
        texto = texto.trim();
        // "**a) texto**": o negrito que abriu antes da letra fecha no fim do texto. Em
        // "**a)** usa **ls**" ele já fechou logo depois de "a)" e o fim é do texto.
        const negrito = marca[2];
        if (negrito && !marca[4] && texto.endsWith(negrito)) texto = texto.slice(0, -negrito.length).trim();
        const letra = marca[3].toUpperCase();
        if (!texto) return;
        if (!letraAceita(letra)) {
            avisos.push(`Questão ${numero}: a alternativa ${marca[3]}) não é aceita (use de a) a ${ULTIMA_LETRA.toLowerCase()})) e ficou de fora.`);
            return;
        }
        alternativas.push({ letter: letra, text: texto });
    });
    return alternativas;
}

function parseEvaluationMarkdownWithWarnings(markdownText, examKey) {
    if (!markdownText) return { evaluation: null, avisos: [] };
    const avisos = [];

    const titleMatch = markdownText.match(/^#\s+(.+)$/m);
    const themeMatch = markdownText.match(/\*\*Tema:\*\*\s*(.+)/);
    const title = titleMatch ? titleMatch[1].replace(/📝\s*/, '').trim() : 'Avaliação';
    const theme = themeMatch ? themeMatch[1].trim() : '';

    let rubricMarkdown = '';
    const rubricMatch = markdownText.match(/(## Parte 2[\s\S]*?)(?=<details>)/);
    if (rubricMatch) {
        rubricMarkdown = rubricMatch[1].trim();
    }

    const gabaritoEscrito = lerGabarito(markdownText);

    const questions = [];
    const questionRegex = /\*\*(\d+)\.\s*(.*?)\*\*\s*\n([\s\S]*?)(?=\*\*\d+\.|## Parte 2|<details>|$)/g;
    let qMatch;

    while ((qMatch = questionRegex.exec(markdownText)) !== null) {
        const qNumber = parseInt(qMatch[1], 10);
        const qText = qMatch[2].trim();
        const escrito = gabaritoEscrito[qNumber] || '';
        if (escrito && !letraAceita(escrito)) {
            avisos.push(`Questão ${qNumber}: o gabarito "${escrito}" não é aceito (use de A a ${ULTIMA_LETRA}). A questão ficou sem gabarito.`);
        }
        const correctAnswer = letraAceita(escrito) ? escrito : '';
        const alternatives = lerAlternativas(qMatch[3], qNumber, avisos).map(alternative => ({
            ...alternative,
            isCorrect: correctAnswer === alternative.letter,
        }));

        // Questão com menos de duas alternativas não vira questão de múltipla escolha,
        // mas sai com aviso (nunca some em silêncio).
        if (alternatives.length < 2) {
            const reconhecidas = alternatives.length === 0 ? 'nenhuma alternativa reconhecida' : 'só 1 alternativa reconhecida';
            avisos.push(`Questão ${qNumber}: ${reconhecidas} (escreva cada uma no começo da linha, como "a) texto"). A questão ficou de fora.`);
            continue;
        }
        if (correctAnswer && !alternatives.some(alternative => alternative.letter === correctAnswer)) {
            avisos.push(`Questão ${qNumber}: o gabarito é ${correctAnswer}, mas a questão não tem a alternativa ${correctAnswer.toLowerCase()}).`);
        }
        questions.push({
            originalNumber: qNumber,
            text: qText,
            weight: 1.0,
            alternatives,
            correctAnswer,
        });
    }

    return {
        evaluation: {
            key: examKey,
            title,
            theme,
            rubric: rubricMarkdown,
            questions,
        },
        avisos,
    };
}

// Mesmo resultado de sempre (sem os avisos), para quem só precisa das questões.
function parseEvaluationMarkdown(markdownText, examKey) {
    return parseEvaluationMarkdownWithWarnings(markdownText, examKey).evaluation;
}

// Questões comparáveis (número, enunciado, gabarito e alternativas), sem os campos
// que outras telas acrescentam depois.
function questoesComparaveis(evaluation) {
    return JSON.stringify((Array.isArray(evaluation?.questions) ? evaluation.questions : []).map(question => [
        Number(question?.originalNumber),
        String(question?.text ?? ''),
        String(question?.correctAnswer ?? ''),
        (Array.isArray(question?.alternatives) ? question.alternatives : []).map(alt => [String(alt?.letter ?? ''), String(alt?.text ?? '')]),
    ]));
}

// O que a avaliação GRAVADA tem de errado, sem olhar o arquivo: alternativa com outra
// colada no texto (a versão antiga, só de a) a d), gravava a e) dentro da d) e perdia o
// gabarito "E").
function avisosDaAvaliacaoGravada(evaluation) {
    const avisos = [];
    (Array.isArray(evaluation?.questions) ? evaluation.questions : []).forEach((question, index) => {
        const numero = question?.originalNumber ?? index + 1;
        (Array.isArray(question?.alternatives) ? question.alternatives : []).forEach(alt => {
            const colada = String(alt?.text ?? '').match(ALTERNATIVA_COLADA);
            if (!colada) return;
            const semGabarito = String(question?.correctAnswer ?? '').trim() ? '' : ', escolha o gabarito';
            avisos.push(`Questão ${numero}: a alternativa ${colada[1]}) ficou colada no texto da ${String(alt?.letter ?? '').toLowerCase()}) (a prova foi lida por uma versão que só aceitava de a) a d)). Abra a prova no editor, separe as alternativas${semGabarito} e salve.`);
        });
    });
    return avisos;
}

// Avisos de importação de uma avaliação gravada que veio do .md (ainda não salva no
// editor). Os avisos do arquivo só valem quando a avaliação gravada é a que o arquivo
// dá hoje; se ela é outra (gravada por uma versão anterior ou por outro caminho, como
// o seed de demonstração), o aviso sai dela mesma, nunca de um arquivo que não é o dela.
function importWarningsFor(storedEvaluation, markdownText, examKey) {
    if (!storedEvaluation) return [];
    const parsed = markdownText ? parseEvaluationMarkdownWithWarnings(markdownText, examKey) : { evaluation: null, avisos: [] };
    if (parsed.evaluation && questoesComparaveis(parsed.evaluation) === questoesComparaveis(storedEvaluation)) return parsed.avisos;
    return avisosDaAvaliacaoGravada(storedEvaluation);
}

module.exports = {
    LETRAS_ACEITAS,
    avisosDaAvaliacaoGravada,
    importWarningsFor,
    parseEvaluationMarkdown,
    parseEvaluationMarkdownWithWarnings,
};
