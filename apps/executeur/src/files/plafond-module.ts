import type { Places } from "./semaphore.ts";

// Plafond par module (A-415) : nombre maximal de places d'une même automatisation sur la cellule. Réutilise le mécanisme de places par bail du sémaphore,
// avec la clé « module:<id> » (jamais un identifiant de client). 0 = pas de plafond (interrupteur fermé par défaut).
export class PlafondModule {
  constructor(
    private places: Places,
    private config: { placesParModule: number; bailPlaceMs: number },
  ) {}
  private cle = (moduleId: string) => `module:${moduleId}`;
  async acquerir(moduleId: string, proprietaire: string): Promise<boolean> {
    return this.config.placesParModule <= 0 || this.places.prendre(this.cle(moduleId), this.config.placesParModule, proprietaire, this.config.bailPlaceMs);
  }
  async prolonger(moduleId: string, proprietaire: string): Promise<boolean> {
    return this.config.placesParModule <= 0 || this.places.prolonger(this.cle(moduleId), proprietaire, this.config.bailPlaceMs);
  }
  async liberer(moduleId: string, proprietaire: string): Promise<void> {
    if (this.config.placesParModule > 0) await this.places.rendre(this.cle(moduleId), proprietaire);
  }
}
