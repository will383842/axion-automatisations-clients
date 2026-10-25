import type { Horloge } from "./ports.ts";

const MAX_MINUTERIE = 2 ** 31 - 1;

export class HorlogeSysteme implements Horloge {
  maintenant = () => Date.now();
  alea = () => Math.random();
  attendre(ms: number, signal?: AbortSignal): Promise<void> {
    // setTimeout plafonne à 2^31-1 ms : au-delà, l'attente est découpée.
    return new Promise((resolu) => {
      let t: ReturnType<typeof setTimeout>;
      const pas = (reste: number) => void (t = setTimeout(() => (reste > MAX_MINUTERIE ? pas(reste - MAX_MINUTERIE) : resolu()), Math.min(reste, MAX_MINUTERIE)));
      pas(ms);
      signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
    });
  }
}

// Temps injectable : rien n'attend pour de vrai, `piloter` avance le temps jusqu'à la fin de la promesse.
export class HorlogeFactice implements Horloge {
  attentes: number[] = [];
  aleas: number[] = [];
  #minuteries: { a: number; resoudre: () => void }[] = [];
  constructor(private t = 1_000_000) {}
  maintenant = () => this.t;
  regler(t: number) {
    this.t = t;
  }
  alea = () => this.aleas.shift() ?? 0;
  attendre(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) this.attentes.push(ms); // les délais coupe-étape passent un signal : seules les attentes de la politique sont notées
    return new Promise((resoudre) => {
      const m = { a: this.t + ms, resoudre };
      this.#minuteries.push(m);
      signal?.addEventListener("abort", () => (this.#minuteries = this.#minuteries.filter((x) => x !== m)), { once: true });
    });
  }
  async piloter<T>(promesse: Promise<T>): Promise<T> {
    let fini = false;
    const suivie = promesse.finally(() => void (fini = true));
    suivie.catch(() => undefined);
    while (!fini) {
      await new Promise((r) => setImmediate(r));
      const prochaine = this.#minuteries.sort((x, y) => x.a - y.a)[0];
      if (fini || !prochaine) continue;
      this.#minuteries.shift();
      this.t = Math.max(this.t, prochaine.a);
      prochaine.resoudre();
    }
    return suivie;
  }
}
