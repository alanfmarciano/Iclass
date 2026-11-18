// Leitura das avaliações antigas em Markdown (content/<prova>.md): título, tema,
// rubrica, gabarito dentro de <details> e questões de múltipla escolha.
//
// Alternativas e gabarito vão de a) a e) (antes só a-d: a alternativa e) entrava
// colada no texto da d) e o gabarito "E" sumia). Letra depois de e) não é aceita:
// a alternativa fica de fora, mas nunca em silêncio. Cada recusa vira um aviso em
// português, devolvido por parseEvaluationMarkdownWithWarnings (registro do boot e
// tela de Provas ao abrir a prova pela primeira vez).
const LETRAS_ACEITAS = 'ABCDE';
const ULTIMA_LETRA = LETRAS_ACEITAS[LETRAS_ACEITAS.length - 1];

// Início de uma alternativa: a letra minúscula e o parêntese no começo da linha
// ("a) texto"). Qualquer letra é reconhecida aqui para que a f) não se cole no
// texto da e); quem decide se ela vale é LETRAS_ACEITAS.
const INICIO_ALTERNATIVA = /(^|\n)[ \t]*([a-z])\)[ \t]*/g;
// Fim do texto da última alternativa: separador, próxima questão, título ou HTML.
const FIM_DO_BLOCO = /\n---|\n\*\*|\n##|\n</;

function letraAceita(letra) {
    return LETRAS_ACEITAS.includes(String(letra || '').toUpperCase());
}

function lerGabarito(markdownText, avisos) {
    const gabarito = {};
    const detailsMatch = markdownText.match(/<details>([\s\S]*?)<\/details>/);
    if (!detailsMatch) return gabarito;
    const detailsContent = detailsMatch[1];
    const registrar = (numero, letra) => {
        const upper = letra.toUpperCase();
        if (!letraAceita(upper)) {
            avisos.push(`Questão ${numero}: o gabarito "${upper}" não é aceito (use de A a ${ULTIMA_LETRA}). A questão ficou sem gabarito.`);
            return;
        }
        gabarito[numero] = upper;
    };
    // Detalhado: "1. **C**". Compacto: "1. C" (só quando não há o detalhado).
    const detalhado = [...detailsContent.matchAll(/(\d+)\.\s*\*\*([A-Za-z])\*\*/g)];
    if (detalhado.length) {
        detalhado.forEach(m => registrar(parseInt(m[1], 10), m[2]));
    } else {
        for (const m of detailsContent.matchAll(/(\d+)\.\s*([A-Za-z])\b/g)) registrar(parseInt(m[1], 10), m[2]);
    }
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
        const letra = marca[2].toUpperCase();
        if (!texto) return;
        if (!letraAceita(letra)) {
            avisos.push(`Questão ${numero}: a alternativa ${marca[2]}) não é aceita (use de a) a ${ULTIMA_LETRA.toLowerCase()})) e ficou de fora.`);
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

    const gabarito = lerGabarito(markdownText, avisos);

    const questions = [];
    const questionRegex = /\*\*(\d+)\.\s*(.*?)\*\*\s*\n([\s\S]*?)(?=\*\*\d+\.|## Parte 2|<details>|$)/g;
    let qMatch;

    while ((qMatch = questionRegex.exec(markdownText)) !== null) {
        const qNumber = parseInt(qMatch[1], 10);
        const qText = qMatch[2].trim();
        const alternatives = lerAlternativas(qMatch[3], qNumber, avisos).map(alternative => ({
            ...alternative,
            isCorrect: gabarito[qNumber] === alternative.letter,
        }));

        if (alternatives.length >= 2) {
            const correctAnswer = gabarito[qNumber] || '';
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

module.exports = {
    LETRAS_ACEITAS,
    parseEvaluationMarkdown,
    parseEvaluationMarkdownWithWarnings,
};
