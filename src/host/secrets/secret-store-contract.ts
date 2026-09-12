/** Data-only port implemented by every credential store adapter. */
export interface SecretStore {
  /** Read a secret; return null when it does not exist. */
  get(key: string): string | null;
  /** Store or replace a secret. */
  set(key: string, value: string): void;
  /** Delete a secret; deleting a missing value is idempotent. */
  delete(key: string): void;
}
