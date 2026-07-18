function parseEvaluationMarkdown(markdownText, examKey) {
    if (!markdownText) return null;

    const titleMatch = markdownText.match(/^#\s+(.+)$/m);
    const themeMatch = markdownText.match(/\*\*Tema:\*\*\s*(.+)/);
    const title = titleMatch ? titleMatch[1].replace(/📝\s*/, '').trim() : 'Avaliação';
    const theme = themeMatch ? themeMatch[1].trim() : '';

    let rubricMarkdown = '';
    const rubricMatch = markdownText.match(/(## Parte 2[\s\S]*?)(?=<details>)/);
    if (rubricMatch) {
        rubricMarkdown = rubricMatch[1].trim();
    }

    const gabarito = {};
    const detailsMatch = markdownText.match(/<details>([\s\S]*?)<\/details>/);
    if (detailsMatch) {
        const detailsContent = detailsMatch[1];
        const detailedMatches = detailsContent.matchAll(/(\d+)\.\s*\*\*([A-Da-d])\*\*/g);
        for (const m of detailedMatches) {
            gabarito[parseInt(m[1])] = m[2].toUpperCase();
        }
        if (Object.keys(gabarito).length === 0) {
            const compactMatches = detailsContent.matchAll(/(\d+)\.\s*([A-Da-d])\b/g);
            for (const m of compactMatches) {
                gabarito[parseInt(m[1])] = m[2].toUpperCase();
            }
        }
    }

    const questions = [];
    const questionRegex = /\*\*(\d+)\.\s*(.*?)\*\*\s*\n([\s\S]*?)(?=\*\*\d+\.|## Parte 2|<details>|$)/g;
    let qMatch;
    
    while ((qMatch = questionRegex.exec(markdownText)) !== null) {
        const qNumber = parseInt(qMatch[1]);
        const qText = qMatch[2].trim();
        const alternativesBlock = qMatch[3];

        const alternatives = [];
        const altRegex = /([a-d])\)\s*(.+?)(?=\n[a-d]\)|\n---|\n\*\*|\n##|\n<|$)/gs;
        let altMatch;
        while ((altMatch = altRegex.exec(alternativesBlock)) !== null) {
            alternatives.push({
                letter: altMatch[1].toUpperCase(),
                text: altMatch[2].trim(),
                isCorrect: gabarito[qNumber] === altMatch[1].toUpperCase()
            });
        }

        if (alternatives.length >= 2) {
            questions.push({
                originalNumber: qNumber,
                text: qText,
                weight: 1.0,
                alternatives: alternatives,
                correctAnswer: gabarito[qNumber] || ""
            });
        }
    }

    return {
        key: examKey,
        title,
        theme,
        rubric: rubricMarkdown,
        questions
    };
}

module.exports = {
    parseEvaluationMarkdown
};
