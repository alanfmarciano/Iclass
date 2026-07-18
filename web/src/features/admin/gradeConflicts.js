// Detecção de conflito de horário: um professor não pode estar em duas turmas
// no mesmo dia da semana e no mesmo horário de início. Só considera vínculos
// diretos de turma (assignedClasses); acessos amplos (escola/curso) são ignorados
// para não gerar ruído. Função pura — sem estado, testável isoladamente.

const WD_LABEL = { '0': 'Domingo', '1': 'Segunda', '2': 'Terça', '3': 'Quarta', '4': 'Quinta', '5': 'Sexta', '6': 'Sábado' }

// Conjunto de "dia|início" ocupados por uma grade.
function slotSet(grade) {
  const set = new Set()
  Object.entries(grade || {}).forEach(([wd, aulas]) => {
    ;(aulas || []).forEach(a => { if (a && a.inicio) set.add(`${wd}|${a.inicio}`) })
  })
  return set
}

function teachesClass(professor, courseId, className) {
  return (professor.assignedClasses || []).some(item => item && item.courseId === courseId && item.className === className)
}

/**
 * Detecta choques entre a grade proposta para uma turma e as demais turmas que
 * os mesmos professores já lecionam.
 * @returns {Array<{professor:string, professorEmail:string, otherClass:string, otherCourseId:string, weekday:string, weekdayLabel:string, inicio:string}>}
 */
export function detectTeacherClashes({ courseId, className, grade, allClasses = [], professors = [] }) {
  const proposedSlots = slotSet(grade)
  if (proposedSlots.size === 0) return []

  const clashes = []
  const seen = new Set()
  const responsaveis = professors.filter(p => teachesClass(p, courseId, className))

  responsaveis.forEach(prof => {
    ;(prof.assignedClasses || []).forEach(assign => {
      if (!assign || (assign.courseId === courseId && assign.className === className)) return // a própria turma
      const other = allClasses.find(c => c.courseId === assign.courseId && c.name === assign.className)
      if (!other) return
      const otherSlots = slotSet(other.attendanceConfig && other.attendanceConfig.grade)
      otherSlots.forEach(slot => {
        if (!proposedSlots.has(slot)) return
        const [wd, inicio] = slot.split('|')
        const key = `${prof.email}|${assign.courseId}|${assign.className}|${slot}`
        if (seen.has(key)) return
        seen.add(key)
        clashes.push({
          professor: prof.name || prof.email,
          professorEmail: prof.email,
          otherClass: assign.className,
          otherCourseId: assign.courseId,
          weekday: wd,
          weekdayLabel: WD_LABEL[wd] || wd,
          inicio,
        })
      })
    })
  })

  return clashes
}
