/** The question a location hash points at, when it is one of `ids`. The hash is compared as it is, not
 * decoded: question ids are only [a-z0-9-], and decoding a stray "%" would throw. Null otherwise. */
export function faqHashTarget(hash: string, ids: readonly string[]): string | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return id !== "" && ids.includes(id) ? id : null;
}
