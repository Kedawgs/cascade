/** A setting the Worker can't run with. The message names the field and what is wrong with it, never
 * the value: a field may be a secret (a keyed RPC URL, private thresholds, the alert recipients). */
export class ConfigError extends Error {
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`${field} ${problem}`);
    this.name = "ConfigError";
    this.field = field;
  }
}
