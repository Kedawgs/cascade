import { scrubSecrets } from "./send.ts";

/** Every line the CLI prints goes through these, with any URL's secrets stripped (scrubSecrets: two
 * regular expressions a line). */
export const printLine = (line: string) => console.log(scrubSecrets(line));
export const printError = (text: string) => console.error(scrubSecrets(text));
