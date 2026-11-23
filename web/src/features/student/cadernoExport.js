// Caderno para levar (fase 3, C17 / P5-S3; UXA-14, D25 do P5): o texto do "Baixar caderno
// (.txt)" e o documento do "Imprimir caderno" (printDocument, com o cabeçalho da escola).
// O caderno vem de GET /api/student/notebook: { geral, unidades: [{ chave, titulo,
// modulo, nota, destaques: [{ paragrafo, trecho, nota }] }], anteriores? }.
import { formatGeneratedAt } from '../../lib/printDocument'

const LINE = '\r\n'

function clean(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

function hasText(value) {
  return clean(value).trim() !== ''
}

// O caderno inteiro em seções na ordem da tela: anotações gerais, cada unidade (título,
// módulo, nota e destaques) e as anotações de antes (formato antigo), quando houver.
export function notebookSections(notebook, { geral } = {}) {
  const data = notebook && typeof notebook === 'object' ? notebook : {}
  const general = geral !== undefined ? geral : data.geral
  const sections = []
  if (hasText(general)) sections.push({ titulo: 'Anotações gerais', nota: clean(general), destaques: [] })
  ;(Array.isArray(data.unidades) ? data.unidades : []).forEach((unit) => {
    if (!unit) return
    sections.push({
      chave: unit.chave ? String(unit.chave) : '',
      titulo: String(unit.titulo || unit.chave || 'Unidade'),
      modulo: String(unit.modulo || ''),
      nota: hasText(unit.nota) ? clean(unit.nota) : '',
      destaques: (Array.isArray(unit.destaques) ? unit.destaques : []).filter((item) => item && (hasText(item.trecho) || hasText(item.nota))),
    })
  })
  const old = data.anteriores
  if (old && (hasText(old.nota) || (Array.isArray(old.destaques) && old.destaques.length))) {
    sections.push({ titulo: 'Anotações anteriores', nota: hasText(old.nota) ? clean(old.nota) : '', destaques: Array.isArray(old.destaques) ? old.destaques : [] })
  }
  return sections
}

// Texto do .txt (com BOM e quebra de linha do Windows: abre certo no Bloco de Notas).
export function notebookText({ notebook, geral, studentName, courseName, studentClass, when = new Date(), timeZone } = {}) {
  const sections = notebookSections(notebook, { geral })
  const lines = [`Caderno${studentName ? ` de ${studentName}` : ''}`]
  const context = [courseName, studentClass ? `Turma ${studentClass}` : ''].filter(Boolean).join(' · ')
  if (context) lines.push(context)
  lines.push(`Baixado em ${formatGeneratedAt(when, timeZone)}`)
  if (!sections.length) {
    lines.push('', 'O caderno ainda está vazio.')
  }
  sections.forEach((section) => {
    lines.push('', `=== ${section.modulo ? `${section.modulo} · ` : ''}${section.titulo} ===`)
    if (section.nota) lines.push(...section.nota.split('\n'))
    if (section.destaques.length) {
      lines.push('', 'Destaques:')
      section.destaques.forEach((item) => {
        const trecho = clean(item.trecho).trim()
        const nota = clean(item.nota).trim()
        if (trecho) lines.push(`- "${trecho.replace(/\n+/g, ' ')}"`)
        if (nota) nota.split('\n').forEach((line, index) => lines.push(`${trecho || index > 0 ? '  ' : '- '}${line}`))
      })
    }
  })
  return `﻿${lines.join(LINE)}${LINE}`
}

// Nome do arquivo: caderno-<curso>-<AAAA-MM-DD>.txt, só letras sem acento, números e '-'.
export function notebookFileName(courseName, when = new Date()) {
  const slug = String(courseName || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const date = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `caderno${slug ? `-${slug}` : ''}-${day}.txt`
}

// Opções do printDocument: uma seção por bloco do caderno, com a nota em texto (a quebra
// de linha fica) e os destaques numa tabela. Todo texto do aluno é escapado pelo
// printDocument.
export function notebookPrintOptions({ notebook, geral, studentName, courseName, studentClass, escola, displayName, when, timeZone } = {}) {
  const sections = notebookSections(notebook, { geral })
  const secoes = sections.length
    ? sections.map((section) => ({
      titulo: section.titulo,
      paragrafos: [section.modulo ? `Módulo: ${section.modulo}` : '', section.nota],
      tabela: section.destaques.length
        ? { colunas: ['Trecho destacado', 'Minha anotação'], linhas: section.destaques.map((item) => [clean(item.trecho), clean(item.nota)]) }
        : undefined,
    }))
    : [{ texto: 'O caderno ainda está vazio.' }]
  return {
    titulo: 'Caderno',
    subtitulo: [studentName, courseName, studentClass ? `Turma ${studentClass}` : ''].filter(Boolean).join(' · '),
    escola,
    displayName,
    geradoEm: when,
    fuso: timeZone,
    secoes,
  }
}
