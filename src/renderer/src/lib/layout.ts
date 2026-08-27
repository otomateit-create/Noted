/**
 * La disposition de l'espace de travail, d'une session a l'autre.
 *
 * Meme raisonnement que pour la position de lecture : ce n'est pas une donnee
 * de travail, cela n'a rien a faire dans le vault, et cela vit donc dans le
 * navigateur. Un PDF dense demande un panneau de cours large, un chapitre a
 * resumer demande la feuille de notes en grand — regler cela a chaque
 * ouverture est exactement le genre de friction qu'on cherche a supprimer.
 */

const CLE = 'noted.disposition'

/** Les trois sections de l'espace de travail, et lesquelles sont a l'ecran. */
export interface Panneaux {
  course: boolean
  notes: boolean
  chat: boolean
}

export interface Disposition {
  courseWidth: number
  chatWidth: number
  panneaux: Panneaux
  /**
   * La part du cours quand les notes sont masquees et qu'il partage l'ecran
   * avec l'assistant. C'est le seul cas ou aucun panneau souple n'absorbe le
   * reste : les deux se partagent la largeur, par moitie tant qu'on n'a pas
   * tire le separateur.
   */
  partage: number
}

export const DISPOSITION_DEFAUT: Disposition = {
  courseWidth: 520,
  chatWidth: 380,
  panneaux: { course: true, notes: true, chat: true },
  partage: 0.5
}

function lirePanneaux(lu: Record<string, unknown>): Panneaux {
  const enregistres = lu.panneaux as Partial<Panneaux> | undefined
  if (enregistres && typeof enregistres.course === 'boolean') {
    return {
      course: enregistres.course,
      notes: enregistres.notes !== false,
      chat: enregistres.chat !== false
    }
  }

  // Reglage d'avant les trois boutons : seul l'assistant se masquait. On le
  // reprend plutot que de le perdre — quelqu'un qui travaillait sans assistant
  // ne doit pas le voir revenir a la mise a jour.
  return { course: true, notes: true, chat: lu.chatOpen !== false }
}

export function dispositionRetenue(): Disposition {
  const brut = window.localStorage.getItem(CLE)
  if (!brut) return DISPOSITION_DEFAUT

  try {
    const lu = JSON.parse(brut) as Record<string, unknown>
    return {
      // Les bornes sont appliquees a l'usage par App ; ici on ne se protege
      // que d'un fichier abime, pas d'un reglage extreme mais volontaire.
      courseWidth:
        typeof lu.courseWidth === 'number' ? lu.courseWidth : DISPOSITION_DEFAUT.courseWidth,
      chatWidth: typeof lu.chatWidth === 'number' ? lu.chatWidth : DISPOSITION_DEFAUT.chatWidth,
      panneaux: lirePanneaux(lu),
      // Une part hors des bornes rendrait un panneau invisible : on la ramene
      // au milieu plutot que de faire confiance au fichier.
      partage:
        typeof lu.partage === 'number' && lu.partage > 0.05 && lu.partage < 0.95
          ? lu.partage
          : DISPOSITION_DEFAUT.partage
    }
  } catch {
    return DISPOSITION_DEFAUT
  }
}

export function retenirDisposition(disposition: Disposition): void {
  window.localStorage.setItem(CLE, JSON.stringify(disposition))
}
