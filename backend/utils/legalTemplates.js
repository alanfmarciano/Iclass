// Modelos dos Termos de Uso e da Política de Privacidade (H8a-1; SEG-08, OPS-12).
//
// Ponto de partida pronto, que funciona sem internet: a escola revisa, ajusta e publica
// na página Privacidade (LGPD) do painel. Enquanto nada for publicado, as páginas
// /termos e /privacidade mostram este modelo, preenchido com os dados da escola, com o
// aviso de que ainda não foi revisado, e ninguém precisa aceitar nada (decisão P4).
//
// Os marcadores {{...}} são trocados na hora de mostrar (utils/legalDocuments.js,
// renderLegalMarkdown), pela lista fechada LEGAL_PLACEHOLDERS. O texto guardado (modelo,
// rascunho ou versão publicada) fica sempre com os marcadores, para os dados da escola
// valerem também depois de uma mudança no cadastro dela.
//
// MODEL_ID muda quando o texto do modelo muda: é ele que identifica o modelo no
// documentId ('modelo-2026.1:termos') enquanto a escola não publica.

const MODEL_ID = 'modelo-2026.1';

const MODEL_NOTICE = '> **Modelo de referência; não substitui orientação jurídica.** Revise este texto com a direção da escola e, se possível, com um advogado antes de publicar.';

const TERMS_TITLE = 'Termos de Uso';
const PRIVACY_TITLE = 'Política de Privacidade';

const TERMS_MODEL = `${MODEL_NOTICE}

# Termos de Uso do IClass

Estes Termos de Uso valem para quem usa o IClass de **{{nome_fantasia}}** ({{instituicao}}, CNPJ {{cnpj}}), com endereço em {{endereco}}. O IClass é o ambiente de estudo da escola: materiais das aulas, provas online, caderno, dúvidas, avisos, frequência e notas.

Ao criar a conta ou continuar usando o portal, você declara que leu estes Termos e a Política de Privacidade.

## 1. Conta pessoal

- A conta é pessoal e não pode ser emprestada. Guarde a senha e não a mostre a ninguém.
- Informe dados verdadeiros no cadastro e avise a secretaria quando algum deles mudar.
- Se perceber que outra pessoa usou a sua conta, avise o professor ou a secretaria o quanto antes.
- A escola pode bloquear a conta para proteger você ou os outros alunos, por exemplo depois de muitas tentativas de senha errada.

## 2. Conduta

- Use o IClass só para as atividades da escola.
- Trate colegas, professores e equipe com respeito nas dúvidas, no fórum e nas mensagens.
- Não publique conteúdo ofensivo, discriminatório, violento, com dados pessoais de outras pessoas ou que viole direitos autorais.
- Não tente acessar contas, telas ou dados de outras pessoas, nem atrapalhar o funcionamento do sistema.

## 3. Provas e monitoramento

- As provas online seguem as regras passadas pelo professor: horário, tempo, número de tentativas e materiais permitidos.
- Durante a prova, o IClass registra eventos para garantir a integridade da avaliação, como saídas da tela da prova, tela cheia, e, conforme o modo escolhido pela escola para cada prova, atalhos de teclado (copiar, colar, recortar, menu do botão direito) ou a digitação. As instruções antes de começar a prova dizem o que é registrado naquela prova.
- O professor pode ver esses registros e levá-los em conta na avaliação.
- Prazo de guarda desses registros: {{prazo_monitoramento}}.

## 4. Conteúdo

- Os materiais das aulas pertencem à escola ou aos seus autores e só podem ser usados para estudo pessoal.
- O que você envia (respostas, anotações, dúvidas e arquivos) continua sendo seu, mas a escola pode guardá-lo e usá-lo para fins pedagógicos e de registro escolar.

## 5. Sanções

O descumprimento destes Termos pode levar a advertência, anulação de prova, suspensão ou bloqueio da conta, conforme o regimento escolar da instituição.

## 6. Disponibilidade

O IClass funciona na rede da escola, no computador do professor ou da instituição. Ele pode ficar fora do ar por falta de energia, manutenção ou problemas na rede. Nesses casos, o professor orienta o que fazer com as atividades e as provas afetadas.

## 7. Alterações

Estes Termos podem mudar. Quando uma nova versão for publicada, o IClass pede que você a leia e aceite de novo no próximo acesso.

## 8. Contato

Dúvidas sobre estes Termos: {{contato_instituicao}}. Assuntos de dados pessoais: {{encarregado_nome}}, encarregado pelo tratamento de dados pessoais, pelo contato {{encarregado_contato}}.

Versão: {{versao}}. Publicação: {{data_publicacao}}.
`;

const PRIVACY_MODEL = `${MODEL_NOTICE}

# Política de Privacidade do IClass

Esta Política explica como **{{nome_fantasia}}** trata os dados pessoais de alunos e responsáveis no IClass, conforme a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018, LGPD).

## 1. Quem cuida dos seus dados

- **Controlador:** {{instituicao}}, CNPJ {{cnpj}}, {{endereco}}. Contato: {{contato_instituicao}}.
- **Encarregado pelo tratamento de dados pessoais:** {{encarregado_nome}}. Contato: {{encarregado_contato}}.

## 2. Quais dados são tratados

- **Cadastro:** nome, nome social, e-mail, telefone, turma, curso, situação da matrícula e data de nascimento.
- **Responsável** (para menores de 18 anos): nome, parentesco e contato.
- **Acessibilidade:** necessidades informadas por você ou pela escola, como tempo adicional de prova, usadas só para adaptar as atividades.
- **Vida escolar:** notas, frequência, entregas, respostas das provas, certificados e observações pedagógicas.
- **Monitoramento de prova:** saídas da tela, tela cheia e, conforme o modo escolhido para cada prova, atalhos de teclado ou a digitação durante a prova.
- **Registros de acesso:** data, hora, endereço IP e aparelho de cada entrada no portal.
- **Conteúdo enviado:** anotações do caderno, dúvidas, mensagens no fórum e arquivos.

## 3. Para que os dados são usados

- Oferecer as aulas, os materiais e as atividades do curso.
- Aplicar, corrigir e registrar as avaliações, com a integridade necessária.
- Registrar frequência, notas e a vida escolar, como a lei exige das instituições de ensino.
- Acompanhar o aprendizado e oferecer apoio pedagógico e de acessibilidade.
- Manter a segurança das contas e do sistema.
- Comunicar avisos da escola.

## 4. Bases legais

- Execução do contrato de matrícula e procedimentos ligados a ele (art. 7º, II e V, da LGPD).
- Cumprimento de obrigações legais e regulatórias da instituição de ensino (art. 7º, II).
- Dados de acessibilidade e saúde: cumprimento de obrigação legal (art. 11, II, "a").
- Dados de crianças e adolescentes: {{base_legal_menores}}

## 5. Onde os dados ficam

Os dados ficam no computador da escola onde o IClass está instalado e nas cópias de segurança feitas por ela. **O IClass não envia seus dados para a internet** nem para empresas de fora da escola. A escola só compartilha dados com órgãos públicos quando a lei exige.

## 6. Por quanto tempo

- Notas, frequência, entregas, certificados e o histórico escolar são guardados pelo tempo exigido pela legislação educacional.
- Registros do monitoramento de prova: {{prazo_monitoramento}}.
- Registros de acesso: {{prazo_acessos}}.
- Itens excluídos que vão para a lixeira: {{prazo_lixeira}}.
- Cópias de segurança: {{copias_seguranca}}

## 7. Seus direitos

Você (ou o seu responsável, se for menor de 18 anos) pode pedir, a qualquer momento (art. 18 da LGPD):

- confirmação de que os seus dados são tratados e acesso a eles;
- correção de dados incompletos, inexatos ou desatualizados;
- cópia dos dados em formato legível (portabilidade);
- anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desacordo com a lei, respeitados os registros que a escola é obrigada a guardar;
- informação sobre com quem os dados são compartilhados;
- revisão de decisões tomadas só por tratamento automatizado.

Para exercer esses direitos, use a opção **Meus dados** do portal, quando disponível, ou fale com o encarregado ({{encarregado_contato}}). A resposta sai em até 15 dias.

## 8. Segurança

O acesso aos dados é restrito a quem precisa deles para o trabalho na escola. Senhas são guardadas de forma protegida, as sessões expiram e as ações importantes ficam registradas na auditoria do sistema.

## 9. Menores de idade

O IClass pede a data de nascimento de todos os alunos. Para menores de 18 anos, pede também o nome e um contato do responsável. Os dados de crianças e adolescentes são tratados sempre no melhor interesse deles (art. 14 da LGPD e Enunciado CD/ANPD nº 1/2023).

## 10. Alterações

Esta Política pode mudar. Quando uma nova versão for publicada, o IClass pede que você a leia de novo no próximo acesso.

Versão: {{versao}}. Publicação: {{data_publicacao}}.
`;

const MODELS = Object.freeze({
    termos: Object.freeze({ kind: 'termos', title: TERMS_TITLE, markdown: TERMS_MODEL }),
    privacidade: Object.freeze({ kind: 'privacidade', title: PRIVACY_TITLE, markdown: PRIVACY_MODEL }),
});

// Texto padrão da base legal para menores (config.privacy.minorsLegalBasis, H8a-2).
const DEFAULT_MINORS_LEGAL_BASIS = "Execução do contrato de matrícula e cumprimento de obrigações legais e regulatórias da instituição de ensino (art. 7º, II e V, e art. 11, II, 'a', da LGPD), sempre no melhor interesse do estudante (art. 14 da LGPD e Enunciado CD/ANPD nº 1/2023).";

module.exports = {
    MODEL_ID,
    TERMS_MODEL,
    PRIVACY_MODEL,
    TERMS_TITLE,
    PRIVACY_TITLE,
    MODELS,
    DEFAULT_MINORS_LEGAL_BASIS,
};
