export function unescapeMarkdownDestination(value: string): string {
  const characters = [...value];
  let unescaped = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    const next = characters[index + 1];
    if (character === "\\" && next !== undefined && isAsciiPunctuation(next)) {
      unescaped += next;
      index += 1;
    } else {
      unescaped += character;
    }
  }

  return unescaped;
}

function isAsciiPunctuation(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}
