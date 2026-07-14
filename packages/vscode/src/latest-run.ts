export class LatestRunTracker {
  readonly #generations = new Map<string, number>();

  begin(key: string): () => boolean {
    const generation = (this.#generations.get(key) ?? 0) + 1;
    this.#generations.set(key, generation);
    return () => this.#generations.get(key) === generation;
  }
}
