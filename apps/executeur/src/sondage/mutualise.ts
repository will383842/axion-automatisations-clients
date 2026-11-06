// Sondage mutualisé (A-416) : une lecture par (connexion, intervalle), partagée par toutes les instances du client qui utilisent cette connexion.
// La clé est la CONNEXION (client + compte), jamais l'adresse de la boîte : deux clients qui auraient la même adresse ne sont pas fusionnés.
// Le curseur appartient à la connexion ; il n'avance qu'après une lecture réussie. Chaque instance voit chaque élément une fois.
export interface Lecture<T> {
  elements: T[];
  curseur: string;
}

interface Etat<T> {
  curseur: string | undefined;
  derniere: number | undefined;
  sale: boolean;
  enCours: Promise<void> | undefined;
  no: number;
  lectures: { no: number; elements: T[]; a: number }[];
  vus: Map<string, number>;
}

export interface OptionsSondage {
  maintenant(): number;
  intervalleMs: number;
  // Le connecteur offre les notifications du fournisseur : la lecture suit la notification, avec un filet de sécurité de 10 intervalles.
  notifications?: boolean;
}

export class SondageMutualise<T = string> {
  #m = new Map<string, Etat<T>>();
  constructor(private o: OptionsSondage) {}
  notifier(cle: string): void {
    const e = this.#m.get(cle);
    if (e) e.sale = true;
  }
  async lire(cle: string, instanceId: string, releve: (curseur: string | undefined) => Promise<Lecture<T>>): Promise<{ elements: T[]; curseur: string | undefined }> {
    const e = this.#m.get(cle) ?? this.#m.set(cle, { curseur: undefined, derniere: undefined, sale: false, enCours: undefined, no: 0, lectures: [], vus: new Map() }).get(cle)!;
    const age = e.derniere === undefined ? Infinity : this.o.maintenant() - e.derniere;
    const echu = this.o.notifications ? e.sale || age >= 10 * this.o.intervalleMs : age >= this.o.intervalleMs;
    if (echu && !e.enCours) {
      e.enCours = (async () => {
        try {
          const r = await releve(e.curseur);
          e.curseur = r.curseur;
          e.derniere = this.o.maintenant();
          e.lectures.push({ no: ++e.no, elements: r.elements, a: e.derniere });
          e.sale = false;
        } finally {
          e.enCours = undefined;
        }
      })();
    }
    if (e.enCours) await e.enCours;
    const vu = e.vus.get(instanceId) ?? 0;
    const elements = e.lectures.filter((l) => l.no > vu).flatMap((l) => l.elements);
    e.vus.set(instanceId, e.no);
    // Lectures vues par toutes les instances connues et vieilles d'un intervalle (le temps que les autres instances du même tour arrivent) : oubliées.
    // Bornées à 50 si une instance ne revient jamais.
    const plancher = Math.min(...e.vus.values());
    const maintenant = this.o.maintenant();
    e.lectures = e.lectures.filter((l) => l.no > plancher || maintenant - l.a < this.o.intervalleMs).slice(-50);
    return { elements, curseur: e.curseur };
  }
}
