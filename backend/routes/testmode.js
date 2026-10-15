// Dados de demonstração usados pelos três botões de acesso rápido.
// O seed é idempotente: atualiza os registros seed_* sem criar duplicatas.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { DEMO_ACCOUNTS } = require('../utils/demoAccounts.js');
const attendanceUtil = require('../utils/attendance.js');
const { CONTENT_DIR } = require('../runtimePaths.js');
const { applicationToOnlineConfig, createExamApplication } = require('../utils/examApplications.js');

const TEST = process.env.TEST_MODE === '1';
const TEST_ADMIN = DEMO_ACCOUNTS.admin;
const TEST_PROFESSOR = DEMO_ACCOUNTS.professor;
const TEST_STUDENT = DEMO_ACCOUNTS.student;
const TEST_CLASS = '1DES';
const TEST_COURSE = 'curso_legacy_01';
const ACTIVE_EXAM = 'Avaliacao_FUTEC_5';

// Disciplinas do curso de teste (usadas na grade horária de presença).
const TEST_DISCIPLINAS = [
  { id: 'FUTEC', nome: 'Fundamentos de TI', cor: '#4f9bf5' },
  { id: 'FECOP', nome: 'Colaboração e Produtividade', cor: '#33c579' },
  { id: 'IRCOM', nome: 'Instalação de Rec. Comp.', cor: '#f0a929' },
];
// Grade horária semanal: 4 aulas/dia, seg–sex. Horários fixos por aula.
const TEST_AULA_HORARIOS = ['08:00', '08:50', '09:50', '10:40'];
const TEST_GRADE_DISCIPLINAS = {
  '1': ['FUTEC', 'FUTEC', 'FECOP', 'FECOP'],
  '2': ['IRCOM', 'IRCOM', 'IRCOM', 'IRCOM'],
  '3': ['FUTEC', 'FECOP', 'IRCOM', 'FUTEC'],
  '4': ['FECOP', 'FECOP', 'FUTEC', 'FUTEC'],
  '5': ['IRCOM', 'FUTEC', 'FECOP', 'IRCOM'],
};
const TEST_ATTENDANCE_CONFIG = {
  toleranciaMin: 15,
  limiarRiscoPct: 75,
  grade: Object.fromEntries(Object.entries(TEST_GRADE_DISCIPLINAS).map(([wd, discs]) => [
    wd, discs.map((disciplinaId, i) => ({ ordem: i + 1, inicio: TEST_AULA_HORARIOS[i], disciplinaId })),
  ])),
};

const MODULES = [
  ['FUTEC', 'FUTEC — Fund. de TI (80h)', [
    'Sistemas Operacionais + Dispositivos', 'Indústria 4.0 + Internet', 'Hardware + BIOS/UEFI + Periféricos',
    'Instalação de Windows Server + KMS', 'CLI de Linux + Permissões + FHS'
  ]],
  ['FECOP', 'FECOP — Colab. e Prod. (120h)', [
    'Produtividade + Office 365', 'Active Directory + LDAP + Grupos/GPO', 'Serviços em Nuvem + AWS/Azure',
    'Políticas Corporativas + Auditoria/Logs', 'Trabalho Remoto + VPN + Segurança'
  ]],
  ['IRCOM', 'IRCOM — Inst. Rec. Comp. (120h)', [
    'Planejamento de Instalação + Requisitos', 'CLP (PLC) + Redes Industriais', 'Protocolos Industriais + Modbus/OPC-UA',
    'Comissionamento de Sistemas + Testes', 'Manutenção Preventiva e Corretiva'
  ]]
];

const TECH_STRUCTURE = MODULES.map(([id, name, names]) => ({
  id,
  name,
  units: names.map((unitName, index) => ({
    id: String(index + 1),
    name: unitName,
    apostilaKey: `Apostila_${id}_${index + 1}`,
    avaliacaoKey: `Avaliacao_${id}_${index + 1}`,
    files: []
  }))
}));

const STUDENTS = [
  ['Alice Aluna', 'aluno@teste.local', '2026-TI-001', '(11) 99101-1001'],
  ['Bruno Souza', 'bruno.souza@teste.local', '2026-TI-002', '(11) 99101-1002'],
  ['Carla Mendes', 'carla.mendes@teste.local', '2026-TI-003', '(11) 99101-1003'],
  ['Diego Oliveira', 'diego.oliveira@teste.local', '2026-TI-004', '(11) 99101-1004'],
  ['Elisa Ferreira', 'elisa.ferreira@teste.local', '2026-TI-005', '(11) 99101-1005'],
  ['Felipe Santos', 'felipe.santos@teste.local', '2026-TI-006', '(11) 99101-1006'],
  ['Gabriela Lima', 'gabriela.lima@teste.local', '2026-TI-007', '(11) 99101-1007'],
  ['Henrique Costa', 'henrique.costa@teste.local', '2026-TI-008', '(11) 99101-1008'],
  ['Isabela Rocha', 'isabela.rocha@teste.local', '2026-TI-009', '(11) 99101-1009'],
  ['João Martins', 'joao.martins@teste.local', '2026-TI-010', '(11) 99101-1010'],
  ['Karen Alves', 'karen.alves@teste.local', '2026-TI-011', '(11) 99101-1011'],
  ['Lucas Ribeiro', 'lucas.ribeiro@teste.local', '2026-TI-012', '(11) 99101-1012']
];

const RESULT_EXAMS = [
  'Avaliacao_FUTEC_1', 'Avaliacao_FUTEC_4',
  'Avaliacao_FECOP_1', 'Avaliacao_FECOP_3',
  'Avaliacao_IRCOM_1', 'Avaliacao_IRCOM_3'
];

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function upsert(list, predicate, value) {
  const current = list.find(predicate);
  if (current) Object.assign(current, value);
  else list.push(value);
  return current || value;
}

function replaceSeedRows(list, prefix, rows) {
  return (list || []).filter(item => !String(item && item.id || '').startsWith(prefix)).concat(rows);
}

function evaluationFor(moduleId, unitId, title) {
  const key = `Avaliacao_${moduleId}_${unitId}`;
  return {
    key,
    title: `Avaliação — ${title}`,
    theme: title,
    rubric: 'Avaliação demonstrativa do Curso Técnico em TI.',
    questions: [
      { originalNumber: 1, text: `Qual prática está relacionada ao tema “${title}”?`, weight: 1, correctAnswer: 'A', alternatives: [
        { letter: 'A', text: 'Aplicar o procedimento técnico adequado e documentar o resultado.', isCorrect: true },
        { letter: 'B', text: 'Ignorar os requisitos do ambiente.', isCorrect: false },
        { letter: 'C', text: 'Executar alterações sem planejamento.', isCorrect: false },
        { letter: 'D', text: 'Dispensar testes e validações.', isCorrect: false }
      ]},
      { originalNumber: 2, text: 'Antes de uma alteração em produção, o que deve ser feito?', weight: 1, correctAnswer: 'B', alternatives: [
        { letter: 'A', text: 'Apagar os registros anteriores.', isCorrect: false },
        { letter: 'B', text: 'Planejar, registrar e prever recuperação.', isCorrect: true },
        { letter: 'C', text: 'Desativar toda a segurança.', isCorrect: false },
        { letter: 'D', text: 'Compartilhar credenciais.', isCorrect: false }
      ]},
      { originalNumber: 3, text: 'Qual atitude melhora a segurança do ambiente?', weight: 1, correctAnswer: 'C', alternatives: [
        { letter: 'A', text: 'Usar a mesma senha em todos os serviços.', isCorrect: false },
        { letter: 'B', text: 'Liberar acesso irrestrito.', isCorrect: false },
        { letter: 'C', text: 'Aplicar o princípio do menor privilégio.', isCorrect: true },
        { letter: 'D', text: 'Desabilitar logs.', isCorrect: false }
      ]},
      { originalNumber: 4, text: 'Para confirmar que uma atividade foi concluída corretamente, deve-se:', weight: 1, correctAnswer: 'D', alternatives: [
        { letter: 'A', text: 'Confiar apenas na memória.', isCorrect: false },
        { letter: 'B', text: 'Evitar qualquer medição.', isCorrect: false },
        { letter: 'C', text: 'Encerrar sem registrar.', isCorrect: false },
        { letter: 'D', text: 'Testar, validar e documentar.', isCorrect: true }
      ]}
    ]
  };
}

function ensureAccount(account, role, extra = {}) {
  db.memory.admins = db.memory.admins || [];
  const current = db.memory.admins.find(item => item.email && item.email.toLowerCase() === account.email);
  return upsert(db.memory.admins, item => item.email && item.email.toLowerCase() === account.email, {
    ...(current || {}),
    name: account.name,
    email: account.email,
    password: current && current.seedDemo && current.password ? current.password : db.hashPassword(account.password),
    role,
    seedDemo: true,
    ...extra
  });
}

function ensureCourseAndClass() {
  db.memory.courses = db.memory.courses || [];
  const course = upsert(db.memory.courses, item => item.id === TEST_COURSE, {
    id: TEST_COURSE,
    name: db.memory.courses.find(item => item.id === TEST_COURSE)?.name || 'Curso Técnico em TI',
    description: 'Curso técnico com módulos FUTEC, FECOP e IRCOM.',
    schoolId: 'escola_default',
    status: 'active',
    deleted: false,
    deletedAt: null
  });
  if (!Array.isArray(course.structure) || course.structure.length === 0) course.structure = TECH_STRUCTURE;
  course.disciplinas = TEST_DISCIPLINAS.map(d => ({ ...d }));

  const releasedItems = {};
  TECH_STRUCTURE.forEach(module => module.units.forEach(unit => {
    releasedItems[unit.apostilaKey] = true;
    releasedItems[unit.avaliacaoKey] = true;
  }));
  RESULT_EXAMS.slice(0, 5).forEach(key => { releasedItems[`Gabarito_${key}`] = true; });

  db.memory.classes = db.memory.classes || [];
  const existing = db.memory.classes.find(item => item.name === TEST_CLASS && item.courseId === TEST_COURSE);
  const now = Date.now();
  const onlineExamConfigs = {
    ...(existing && existing.onlineExamConfigs || {}),
    [ACTIVE_EXAM]: {
      questionCount: 4, versionCount: 1, shuffleQuestions: true, shuffleAnswers: true,
      durationMinutes: 40, timerEnabled: true, requiresToken: false, waitingRoomDuration: 0,
      onlineActive: true, status: 'running', startTime: now - 15 * 60000, updatedAt: now
    },
    Avaliacao_FECOP_5: {
      questionCount: 4, versionCount: 1, shuffleQuestions: true, shuffleAnswers: true,
      durationMinutes: 50, timerEnabled: true, requiresToken: false, waitingRoomDuration: 0,
      onlineActive: false, status: 'prepared', startTime: null, updatedAt: now
    },
    Avaliacao_IRCOM_5: {
      questionCount: 4, versionCount: 1, shuffleQuestions: true, shuffleAnswers: true,
      durationMinutes: 45, timerEnabled: true, requiresToken: false, waitingRoomDuration: 0,
      onlineActive: false, status: 'prepared', startTime: null, updatedAt: now
    }
  };
  const cls = upsert(db.memory.classes, item => item.name === TEST_CLASS && item.courseId === TEST_COURSE, {
    ...(existing || {}), name: TEST_CLASS, courseId: TEST_COURSE, period: 'Manhã', registrationEnabled: true,
    activeExamKey: ACTIVE_EXAM, activeExamQuestionCount: 4,
    attendanceConfig: JSON.parse(JSON.stringify(TEST_ATTENDANCE_CONFIG)),
    releasedItems: { ...(existing && existing.releasedItems || {}), ...releasedItems },
    examConfigs: existing && existing.examConfigs || {}, onlineExamConfigs
  });
  return { course, cls };
}

function ensureStudents() {
  db.memory.students = db.memory.students || [];
  const now = Date.now();
  STUDENTS.forEach(([name, email, matricula, phone], index) => {
    const current = db.memory.students.find(item => item.email && item.email.toLowerCase() === email);
    const accessibility = index === 2
      ? { fonteAmpliada: true, altoContraste: false, reducaoAnimacoes: false, leitorTela: false, tempoAdicional: true, tempoAdicionalPercent: 25, observacao: 'Prefere materiais com fonte ampliada.' }
      : { fonteAmpliada: false, altoContraste: false, reducaoAnimacoes: false, leitorTela: false, tempoAdicional: false, tempoAdicionalPercent: 0, observacao: '' };
    upsert(db.memory.students, item => item.email && item.email.toLowerCase() === email, {
      ...(current || {}), name, nomeSocial: index === 8 ? 'Isa Rocha' : '', email, matricula, phone,
      unidade: 'Unidade Centro', status: 'Ativo',
      password: current && current.seedDemo && current.password ? current.password : db.hashPassword('teste'),
      classes: [{ name: TEST_CLASS, courseId: TEST_COURSE, period: 'Manhã' }],
      studentClass: TEST_CLASS, period: 'Manhã',
      guardian: { name: `Responsável por ${name.split(' ')[0]}`, phone: `(11) 98888-${String(1100 + index).slice(-4)}`, email: `responsavel.${index + 1}@teste.local`, parentesco: index % 2 ? 'Pai' : 'Mãe', observacao: 'Contato autorizado para assuntos acadêmicos.' },
      accessibility,
      termsAcceptance: { version: '1.0', at: now - (60 - index) * 86400000 },
      privacyAcceptance: { version: '1.0', at: now - (60 - index) * 86400000 },
      lastLoginAt: now - (index + 1) * 3600000,
      lastSeenAt: now - index * 180000,
      createdAt: current && current.createdAt || now - (120 + index) * 86400000,
      updatedAt: now,
      seedDemo: true
    });
  });
}

function seedAcademicData() {
  const now = Date.now();
  const allUnitKeys = TECH_STRUCTURE.flatMap(module => module.units.map(unit => unit.apostilaKey));
  const completionCounts = [9, 12, 6, 15, 8, 10, 4, 13, 7, 11, 5, 14];
  db.memory.progress = db.memory.progress || {};
  db.memory.notes = db.memory.notes || {};
  db.memory.sessions = db.memory.sessions || {};

  const submissions = [];
  const attendance = [];
  const accesses = [];
  const schoolDays = [];
  for (let offset = 1; schoolDays.length < 16; offset++) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    if (date.getDay() !== 0 && date.getDay() !== 6) schoolDays.push(dateOffset(-offset));
  }

  STUDENTS.forEach(([name, email], studentIndex) => {
    const completed = {};
    allUnitKeys.slice(0, completionCounts[studentIndex]).forEach(key => { completed[key] = true; });
    db.memory.progress[email] = completed;
    db.memory.notes[email] = {
      FUTEC: 'Revisar comandos Linux, tipos de armazenamento e etapas de diagnóstico.',
      FECOP: 'Conferir grupos do Active Directory e políticas de acesso antes da próxima aula.',
      IRCOM: 'Resumo dos protocolos industriais e pontos importantes do laboratório.'
    };
    if (studentIndex < 4) db.memory.sessions[email] = now - studentIndex * 60000;

    RESULT_EXAMS.forEach((examKey, examIndex) => {
      const score = 60 + ((studentIndex * 7 + examIndex * 8) % 39);
      const published = !(examIndex === RESULT_EXAMS.length - 1 && studentIndex % 3 === 0);
      const correctCount = Math.max(2, Math.round(score / 25));
      submissions.push({
        id: `seed_sub_${studentIndex + 1}_${examIndex + 1}`,
        student: { name, email, studentClass: TEST_CLASS, courseId: TEST_COURSE },
        examKey, score, correctCount, totalCount: 4,
        gradedAnswers: Array.from({ length: 4 }, (_, questionIndex) => ({
          questionNumber: questionIndex + 1,
          studentChoice: questionIndex < correctCount ? ['A', 'B', 'C', 'D'][questionIndex] : 'A',
          correctAnswer: ['A', 'B', 'C', 'D'][questionIndex],
          isCorrect: questionIndex < correctCount
        })),
        assignedVersion: examIndex % 2 ? 'B' : 'A', examConfigVersion: 1, type: 'online',
        gradePublished: published,
        gradePublishedAt: published ? now - (35 - examIndex * 5) * 86400000 : null,
        gradePublishedBy: published ? TEST_PROFESSOR.email : null,
        timestamp: new Date(now - (40 - examIndex * 6 + studentIndex) * 86400000).toISOString()
      });
    });

    schoolDays.forEach((date, dayIndex) => {
      const gradeAulas = attendanceUtil.gradeForDate({ attendanceConfig: TEST_ATTENDANCE_CONFIG }, date);
      if (!gradeAulas.length) return; // dia sem grade (não deve ocorrer: schoolDays são úteis)
      const absent = (studentIndex + dayIndex) % 17 === 0;
      const justified = !absent && (studentIndex * 2 + dayIndex) % 23 === 0;
      const late = !absent && !justified && (studentIndex * 3 + dayIndex) % 13 === 0;
      const abonado = justified && (studentIndex % 2 === 0);

      let aulas;
      if (absent) {
        aulas = gradeAulas.map(a => ({ ordem: a.ordem, disciplinaId: a.disciplinaId, inicio: a.inicio, status: 'falta', hora: '' }));
      } else if (justified) {
        aulas = gradeAulas.map(a => ({ ordem: a.ordem, disciplinaId: a.disciplinaId, inicio: a.inicio, status: 'justificada', hora: '' }));
      } else if (late) {
        // Chegou depois da tolerância da 1ª aula → falta na 1ª, presente nas demais.
        aulas = attendanceUtil.deriveAulasFromArrival(gradeAulas, '08:30', TEST_ATTENDANCE_CONFIG.toleranciaMin);
      } else {
        aulas = gradeAulas.map(a => ({ ordem: a.ordem, disciplinaId: a.disciplinaId, inicio: a.inicio, status: 'presente', hora: '' }));
      }

      attendance.push({
        id: `seed_att_${studentIndex + 1}_${dayIndex + 1}`,
        studentEmail: email, studentClass: TEST_CLASS, courseId: TEST_COURSE, date,
        origin: 'chamada', aulas,
        justificativa: justified ? {
          tipo: 'atestado', de: date, ate: date, abonado,
          texto: 'Ausência justificada e registrada para demonstração.', arquivo: '', arquivoNome: '',
        } : null,
        markedBy: TEST_PROFESSOR.email,
        timestamp: new Date(`${date}T12:00:00`).getTime()
      });
    });

    const accessIndex = Math.max(0, completionCounts[studentIndex] - 1);
    accesses.push(
      { id: `seed_acc_${studentIndex + 1}_1`, studentEmail: email, key: allUnitKeys[accessIndex], moduleKey: allUnitKeys[accessIndex].split('_')[1], courseId: TEST_COURSE, timestamp: now - (studentIndex + 1) * 3600000 },
      { id: `seed_acc_${studentIndex + 1}_2`, studentEmail: email, key: allUnitKeys[Math.max(0, accessIndex - 1)], moduleKey: allUnitKeys[Math.max(0, accessIndex - 1)].split('_')[1], courseId: TEST_COURSE, timestamp: now - (studentIndex + 2) * 86400000 }
    );
  });

  db.memory.submissions = replaceSeedRows(db.memory.submissions, 'seed_sub_', submissions);
  db.memory.attendance = replaceSeedRows(db.memory.attendance, 'seed_att_', attendance);
  db.memory.moduleAccess = replaceSeedRows(db.memory.moduleAccess, 'seed_acc_', accesses);
}

function seedCommunicationData() {
  const now = Date.now();
  const common = { courseId: TEST_COURSE, author: TEST_PROFESSOR.email, authorName: TEST_PROFESSOR.name, readBy: [] };
  const announcements = [
    { id: 'seed_ann_1', title: 'Bem-vindos ao semestre', message: 'Confira o calendário, os materiais liberados e as atividades da primeira etapa.', target: 'turma', targetValue: TEST_CLASS, priority: 'alta', pinned: true },
    { id: 'seed_ann_2', title: 'Laboratório de hardware', message: 'Na próxima aula utilizaremos o laboratório 2. Tragam o roteiro de diagnóstico.', target: 'turma', targetValue: TEST_CLASS, priority: 'normal', pinned: false },
    { id: 'seed_ann_3', title: 'Material complementar disponível', message: 'A biblioteca recebeu um guia complementar sobre redes e segurança.', target: 'curso', targetValue: TEST_COURSE, priority: 'normal', pinned: false },
    { id: 'seed_ann_4', title: 'Prazo do projeto integrador', message: 'As equipes devem entregar a primeira versão do projeto até a data indicada no calendário.', target: 'curso', targetValue: TEST_COURSE, priority: 'alta', pinned: true },
    { id: 'seed_ann_5', title: 'Acompanhamento individual', message: 'Alice, seu desempenho está bom. Revise o conteúdo de redes industriais antes da próxima avaliação.', target: 'aluno', targetValue: TEST_STUDENT.email, courseId: null, priority: 'normal', pinned: false }
  ].map((item, index) => ({ ...common, ...item, createdAt: now - index * 6 * 3600000, expiresAt: dateOffset(35) }));

  const eventDefs = [
    ['seed_cal_1', 1, '08:00', '09:40', 'aula', 'Aula prática — montagem e diagnóstico', 'Laboratório 2. Levar o roteiro de atividades.', 'turma', TEST_CLASS],
    ['seed_cal_2', 3, '10:00', '10:30', 'aviso', 'Plantão de dúvidas online', 'Encontro para dúvidas sobre FUTEC e atividades pendentes.', 'curso', TEST_COURSE],
    ['seed_cal_3', 5, '08:00', '09:30', 'prova', 'Avaliação de Fundamentos de TI', 'Avaliação individual com duração de 90 minutos.', 'turma', TEST_CLASS],
    ['seed_cal_4', 8, '23:00', '', 'entrega', 'Entrega do projeto integrador — etapa 1', 'Enviar documentação e diagrama da solução.', 'turma', TEST_CLASS],
    ['seed_cal_5', 11, '09:00', '10:00', 'reuniao', 'Reunião de acompanhamento da turma', 'Revisão de progresso, frequência e próximos conteúdos.', 'turma', TEST_CLASS],
    ['seed_cal_6', 15, '08:00', '11:30', 'aula', 'Visita técnica ao datacenter', 'Ponto de encontro na unidade às 07h40.', 'curso', TEST_COURSE],
    ['seed_cal_7', 20, '18:00', '', 'entrega', 'Entrega da atividade de redes', 'Publicar o relatório final no ambiente do curso.', 'curso', TEST_COURSE]
  ];
  const events = eventDefs.map(([id, days, startTime, endTime, eventType, title, message, target, targetValue], index) => ({
    ...common, id, kind: 'calendar', title, message, eventDate: dateOffset(days), startTime, endTime,
    eventType, target, targetValue, createdAt: now - index * 3600000
  }));

  db.memory.announcements = (db.memory.announcements || [])
    .filter(item => !String(item.id || '').startsWith('seed_ann_') && !String(item.id || '').startsWith('seed_cal_'))
    .concat(announcements, events);
}

function seedAdditionalData() {
  const now = Date.now();
  db.memory.forum = replaceSeedRows(db.memory.forum, 'seed_forum_', [
    { id: 'seed_forum_1', key: 'Apostila_FUTEC_3', studentName: 'Bruno Souza', studentEmail: 'bruno.souza@teste.local', text: 'Qual é a melhor ordem para diagnosticar um computador que não liga?', timestamp: new Date(now - 3 * 86400000).toISOString(), status: 'respondida', replies: [{ id: 'seed_reply_1', authorName: TEST_PROFESSOR.name, authorEmail: TEST_PROFESSOR.email, authorRole: 'Instrutor', text: 'Comece pela alimentação, depois verifique conexões, memória e sinais da placa-mãe.', timestamp: new Date(now - 2 * 86400000).toISOString() }], events: [] },
    { id: 'seed_forum_2', key: 'Apostila_FECOP_2', studentName: 'Carla Mendes', studentEmail: 'carla.mendes@teste.local', text: 'Uma GPO aplicada ao domínio sempre substitui a política local?', timestamp: new Date(now - 2 * 86400000).toISOString(), status: 'aberta', replies: [], events: [] },
    { id: 'seed_forum_3', key: 'Apostila_IRCOM_3', studentName: TEST_STUDENT.name, studentEmail: TEST_STUDENT.email, text: 'Podemos comparar Modbus TCP e OPC-UA na próxima aula?', timestamp: new Date(now - 86400000).toISOString(), status: 'respondida', replies: [{ id: 'seed_reply_3', authorName: TEST_PROFESSOR.name, authorEmail: TEST_PROFESSOR.email, authorRole: 'Instrutor', text: 'Sim. Já incluí essa comparação no roteiro da aula prática.', timestamp: new Date(now - 12 * 3600000).toISOString() }], events: [] }
  ]);

  db.memory.pedagogicalObservations = replaceSeedRows(db.memory.pedagogicalObservations, 'seed_obs_', [
    { id: 'seed_obs_1', studentEmail: TEST_STUDENT.email, author: TEST_PROFESSOR.email, category: 'Desempenho', visibility: 'Equipe pedagógica', text: 'Boa participação nas aulas práticas e evolução constante nas avaliações.', timestamp: now - 5 * 86400000, updatedAt: now - 5 * 86400000 },
    { id: 'seed_obs_2', studentEmail: 'bruno.souza@teste.local', author: TEST_PROFESSOR.email, category: 'Acompanhamento', visibility: 'Equipe pedagógica', text: 'Recomendada revisão dos conteúdos de Active Directory antes da próxima atividade.', timestamp: now - 3 * 86400000, updatedAt: now - 3 * 86400000 }
  ]);

  db.memory.certificates = replaceSeedRows(db.memory.certificates, 'seed_cert_', [
    { id: 'seed_cert_1', studentEmail: 'diego.oliveira@teste.local', courseId: TEST_COURSE, courseName: 'Curso Técnico em TI — Módulo FUTEC', code: 'CERT-DEMO-FUTEC-001', status: 'Emitido', issuedAt: now - 20 * 86400000, issuedBy: TEST_PROFESSOR.email }
  ]);
}

// Apostila de demonstração gerada para cada unidade. Só é escrita quando o arquivo
// não existe, então nunca sobrescreve conteúdo real (o modo demonstração usa content-demo/).
function demoApostila(module, unit) {
  return [
    `# ${unit.name}`,
    '',
    `> **Módulo:** ${module.name} · **Unidade ${unit.id}** · material de demonstração do IClass.`,
    '',
    '## Objetivos da aula',
    '',
    `- Entender os conceitos centrais de **${unit.name}**.`,
    '- Relacionar a teoria com situações reais do ambiente de TI.',
    '- Praticar com um roteiro curto e registrar o resultado.',
    '',
    '## Conceitos principais',
    '',
    `Nesta unidade estudamos ${unit.name.toLowerCase()} a partir de três perguntas: o que é, para que serve e como verificar se está funcionando. Cada conceito vem acompanhado de um exemplo do dia a dia de um técnico.`,
    '',
    '| Conceito | Para que serve | Como verificar |',
    '| --- | --- | --- |',
    '| Planejamento | Evitar retrabalho e falhas | Checklist antes de começar |',
    '| Execução | Aplicar o procedimento correto | Registro de cada etapa |',
    '| Validação | Confirmar o resultado | Teste e documentação |',
    '',
    '## Atividade prática',
    '',
    '1. Leia o roteiro completo antes de começar.',
    '2. Execute cada etapa e anote o que observou.',
    '3. Compare o resultado com o esperado e registre as diferenças.',
    '4. Compartilhe uma dúvida no fórum da unidade.',
    '',
    '## Para revisar',
    '',
    '- Quais etapas são obrigatórias antes de uma alteração?',
    '- Como você comprovaria que a atividade foi concluída?',
    '',
  ].join('\n');
}

function seedDemoContent() {
  try {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
    TECH_STRUCTURE.forEach(module => module.units.forEach(unit => {
      const file = path.join(CONTENT_DIR, `${unit.apostilaKey}.md`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, demoApostila(module, unit), 'utf8');
    }));
  } catch (error) {
    console.error('Seed: não foi possível gerar as apostilas de demonstração:', error.message);
  }

  const now = Date.now();
  const link = (id, moduleId, name, url, type, description, tags, ageDays) => ({
    id, kind: 'link', courseId: TEST_COURSE, studentClass: '', moduleId, name, url, type, size: 0,
    description, tags, author: TEST_PROFESSOR.email, createdAt: now - ageDays * 86400000, updatedAt: now - ageDays * 86400000,
  });
  db.memory.library = replaceSeedRows(db.memory.library, 'seed_lib_', [
    link('seed_lib_1', 'FUTEC', 'Documentação do Windows Server', 'https://learn.microsoft.com/pt-br/windows-server/', 'link', 'Referência oficial para instalação e administração.', ['windows', 'servidor'], 6),
    link('seed_lib_2', 'FUTEC', 'Guia de comandos do Linux', 'https://www.debian.org/doc/manuals/debian-reference/', 'link', 'Manual de referência do Debian com comandos e permissões.', ['linux', 'cli'], 5),
    link('seed_lib_3', 'FECOP', 'Introdução ao Active Directory', 'https://learn.microsoft.com/pt-br/windows-server/identity/ad-ds/get-started/virtual-dc/active-directory-domain-services-overview', 'link', 'Visão geral de domínios, grupos e políticas.', ['ad', 'gpo'], 4),
    link('seed_lib_4', 'IRCOM', 'Protocolo Modbus — visão geral', 'https://modbus.org/faq.php', 'link', 'Perguntas frequentes sobre o protocolo Modbus.', ['industrial', 'redes'], 2),
  ]);
}

// Deixa uma aplicação de prova PREPARADA (não iniciada) para o Monitor não abrir vazio.
// Fica em "prepared" para o apresentador iniciá-la ao vivo e para não aparecer aos alunos.
function seedDemoApplication(cls) {
  const evaluation = db.memory.evaluations[ACTIVE_EXAM];
  if (!cls || !evaluation) return;
  db.memory.examApplications = db.memory.examApplications || [];
  let application = db.memory.examApplications.find(item => item && item.seedDemo === true && item.examKey === ACTIVE_EXAM);
  if (!application || ['finished', 'cancelled'].includes(application.status)) {
    db.memory.examApplications = db.memory.examApplications.filter(item => !(item && item.seedDemo === true && item.examKey === ACTIVE_EXAM));
    const questions = evaluation.questions.map((question, index) => ({ ...question, examNumber: index + 1, questionText: question.text }));
    application = createExamApplication({
      examKey: ACTIVE_EXAM, courseId: TEST_COURSE, studentClass: TEST_CLASS,
      historyId: 'seed_history_futec_5',
      config: {
        durationMinutes: 40, timerEnabled: true, waitingRoomDuration: 0, maxAttempts: 1,
        questionCount: questions.length, shuffleQuestions: false, shuffleAnswers: false,
        versionSnapshots: [{ version: 'A', examCode: 'DEMO-FUTEC5', questions }],
      },
      actor: TEST_PROFESSOR.email,
      status: 'prepared',
    });
    application.seedDemo = true;
    db.memory.examApplications.push(application);
  }
  cls.onlineExamConfigs[ACTIVE_EXAM] = applicationToOnlineConfig(application, cls.onlineExamConfigs[ACTIVE_EXAM] || {});
  cls.releasedItems[ACTIVE_EXAM] = false;
  if (cls.activeExamKey === ACTIVE_EXAM) cls.activeExamKey = null;
}

function ensureSeed() {
  // Limpa somente os artefatos criados pelo seed antigo, sem tocar em dados reais.
  db.memory.courses = (db.memory.courses || []).filter(item => !(item.id === 'TESTE' && item.name === 'Curso de Teste'));
  db.memory.classes = (db.memory.classes || []).filter(item => !(item.courseId === 'TESTE' && item.name === 'Turma Teste'));
  db.memory.submissions = (db.memory.submissions || []).filter(item => !(item.student && item.student.courseId === 'TESTE' && String(item.id || '').startsWith('sub_test_')));

  const { cls } = ensureCourseAndClass();
  ensureAccount(TEST_ADMIN, 'admin', { assignedSchoolIds: [], assignedCourseIds: [], assignedClasses: [], additionalPermissions: [] });
  ensureAccount(TEST_PROFESSOR, 'professor', { assignedSchoolIds: [], assignedCourseIds: [], assignedClasses: [{ courseId: TEST_COURSE, className: TEST_CLASS }], additionalPermissions: [] });
  ensureStudents();

  db.memory.evaluations = db.memory.evaluations || {};
  TECH_STRUCTURE.forEach(module => module.units.forEach(unit => {
    if (!db.memory.evaluations[unit.avaliacaoKey]) db.memory.evaluations[unit.avaliacaoKey] = evaluationFor(module.id, unit.id, unit.name);
  }));

  seedAcademicData();
  seedCommunicationData();
  seedAdditionalData();
  seedDemoContent();
  seedDemoApplication(cls);
  db.save();
}

router.get('/api/test-mode', (req, res) => res.json({ enabled: TEST }));

router.post('/api/test/seed', (req, res) => {
  // Seed cria contas administrativas com senha conhecida ("teste"); só pode
  // existir quando o servidor sobe explicitamente em TEST_MODE. Sem esse guard,
  // qualquer requisição local recriava um admin de teste em produção.
  if (!TEST) return res.status(403).json({ error: 'Seed de teste disponível apenas com o servidor em TEST_MODE.' });
  ensureSeed();
  res.json({
    success: true,
    admin: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
    professor: { email: TEST_PROFESSOR.email, password: TEST_PROFESSOR.password },
    student: { email: TEST_STUDENT.email, password: TEST_STUDENT.password },
    exam: { key: ACTIVE_EXAM, className: TEST_CLASS, courseId: TEST_COURSE },
    demo: { students: STUDENTS.length, announcements: 5, calendarEvents: 7, submissions: STUDENTS.length * RESULT_EXAMS.length }
  });
});

module.exports = router;
