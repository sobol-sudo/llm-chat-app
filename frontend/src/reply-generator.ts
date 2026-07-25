/**
 * Browser-side reply generator.
 *
 * The backend builds its answers with Faker (`hacker.phrase()` + `lorem`).
 * Pulling Faker into the browser bundle would add megabytes to a static demo,
 * so this module reproduces the same shape of output with a small word bank.
 * The text is placeholder text on both sides -- nothing here claims to be a
 * language model.
 */

const ABBREVIATIONS = [
  "TCP", "HTTP", "SSL", "SQL", "RAM", "GB", "CSS", "FTP", "PCI", "JSON",
  "XML", "HDD", "SMTP", "USB", "PNG", "IP", "API", "RSS", "AGP", "SAS",
];

const ADJECTIVES = [
  "auxiliary", "primary", "back-end", "digital", "open-source", "virtual",
  "cross-platform", "redundant", "online", "haptic", "multi-byte", "wireless",
  "neural", "optical", "solid state", "mobile", "bluetooth", "1080p",
];

const NOUNS = [
  "driver", "protocol", "bandwidth", "panel", "microchip", "program", "port",
  "card", "array", "interface", "system", "sensor", "firewall", "hard drive",
  "pixel", "alarm", "feed", "monitor", "application", "transmitter", "bus",
  "circuit", "capacitor", "matrix",
];

const VERBS = [
  "back up", "bypass", "hack", "override", "compress", "copy", "navigate",
  "index", "connect", "generate", "quantify", "calculate", "synthesize",
  "input", "transmit", "program", "reboot", "parse",
];

const ING_VERBS = [
  "backing up", "bypassing", "hacking", "overriding", "compressing", "copying",
  "navigating", "indexing", "connecting", "generating", "quantifying",
  "calculating", "synthesizing", "inputting", "transmitting", "programming",
  "rebooting", "parsing",
];

const PHRASE_TEMPLATES = [
  "If we {verb} the {noun}, we can get to the {abbr} {noun} through the {adj} {abbr} {noun}!",
  "We need to {verb} the {adj} {abbr} {noun}!",
  "Try to {verb} the {abbr} {noun}, maybe it will {verb} the {adj} {noun}!",
  "You can't {verb} the {noun} without {ingVerb} the {adj} {abbr} {noun}!",
  "Use the {adj} {abbr} {noun}, then you can {verb} the {adj} {noun}!",
  "The {abbr} {noun} is down, {verb} the {adj} {noun} so we can {verb} the {abbr} {noun}!",
  "{ingVerb} the {noun} won't do anything, we need to {verb} the {adj} {abbr} {noun}!",
  "I'll {verb} the {adj} {abbr} {noun}, that should {verb} the {abbr} {noun}!",
];

const LOREM_WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipisicing",
  "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore",
  "et", "dolore", "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis",
  "nostrud", "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex",
  "ea", "commodo", "consequat", "duis", "aute", "irure", "in", "reprehenderit",
  "voluptate", "velit", "esse", "cillum", "eu", "fugiat", "nulla", "pariatur",
  "excepteur", "sint", "occaecat", "cupidatat", "non", "proident", "sunt",
  "culpa", "qui", "officia", "deserunt", "mollit", "anim", "id", "est",
  "laborum",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function intBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Equivalent of Faker's `hacker.phrase()`. */
function hackerPhrase(): string {
  const template = pick(PHRASE_TEMPLATES);

  return template.replace(/\{(verb|ingVerb|adj|abbr|noun)\}/g, (_, token: string) => {
    switch (token) {
      case "verb":
        return pick(VERBS);
      case "ingVerb":
        return pick(ING_VERBS);
      case "adj":
        return pick(ADJECTIVES);
      case "abbr":
        return pick(ABBREVIATIONS);
      default:
        return pick(NOUNS);
    }
  });
}

function sentence(): string {
  const words: string[] = [];
  const wordCount = intBetween(4, 12);

  for (let i = 0; i < wordCount; i += 1) {
    words.push(pick(LOREM_WORDS));
  }

  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Equivalent of Faker's `lorem.paragraph()`. */
function paragraph(sentenceCount = 3): string {
  const sentences: string[] = [];

  for (let i = 0; i < sentenceCount; i += 1) {
    sentences.push(sentence());
  }

  return sentences.join(" ");
}

/** Equivalent of Faker's `lorem.paragraphs({ min, max }, "\n\n")`. */
function paragraphs(min: number, max: number): string {
  const count = intBetween(min, max);
  const result: string[] = [];

  for (let i = 0; i < count; i += 1) {
    result.push(paragraph());
  }

  return result.join("\n\n");
}

/**
 * Builds the full answer text for a user question, matching the layout the
 * WebSocket backend produces in `backend/src/server.ts`.
 */
export function generateReply(userText: string): string {
  const question = (userText || "").trim();

  const title = hackerPhrase();
  const intro = paragraph();
  const details = paragraphs(1, 2);

  const prefix = question
    ? `You asked: "${question}". Here is a generated answer:\n\n`
    : "Here is an example of a generated answer:\n\n";

  return `${prefix}# ${title}\n\n${intro}\n\n${details}`;
}
