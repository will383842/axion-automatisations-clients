// Une file par cellule : « executions:<cellule> ». La cellule ne porte que les instances de l'état voulu.
export class InstanceHorsCellule extends Error {
  constructor(instanceId: string, cellule: string) {
    super(`l'instance ${instanceId} n'appartient pas à la cellule ${cellule}`);
  }
}

export class Cellule {
  #instances: Set<string>;
  constructor(
    readonly nom: string,
    instances: Iterable<string>,
  ) {
    this.#instances = new Set(instances);
  }
  get nomFile(): string {
    return `executions:${this.nom}`;
  }
  definirInstances(instances: Iterable<string>): void {
    this.#instances = new Set(instances);
  }
  accepter(instanceId: string): void {
    if (!this.#instances.has(instanceId)) throw new InstanceHorsCellule(instanceId, this.nom);
  }
}
