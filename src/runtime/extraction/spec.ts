/**
 * Declarative extraction specs.
 *
 * A workflow says *what* to extract, never *how*:
 *
 * ```ts
 * page.extractAll({
 *   selector: '.publication',
 *   fields: { title: '.title', url: 'a@href', date: '.date' },
 * })
 * ```
 *
 * Each field is `[selector][@attribute]`, relative to the matched item:
 *
 * | Spec            | Meaning                                        |
 * |-----------------|------------------------------------------------|
 * | `.title`        | text content of the first `.title` descendant  |
 * | `a@href`        | `href` attribute of the first `a` descendant   |
 * | `@data-id`      | `data-id` attribute of the item itself         |
 * | `@text`         | text content of the item itself                |
 * | `.body@html`    | inner HTML of the first `.body` descendant     |
 *
 * Parsing is pure and shared by every backend, so the CDP adapter and the fake
 * cannot disagree about what a spec means — which is the whole point of testing
 * extraction without a browser.
 */

/** Pseudo-attributes that read content rather than a real HTML attribute. */
export const TEXT_PSEUDO_ATTRIBUTE = 'text';
export const HTML_PSEUDO_ATTRIBUTE = 'html';

export interface FieldSpec {
  /** Selector relative to the item, or `null` to mean the item itself. */
  readonly selector: string | null;
  /** Attribute name, or `text` / `html` pseudo-attributes. Defaults to `text`. */
  readonly attribute: string;
}

export interface ExtractSpec {
  /** Selector matching each item to extract. */
  readonly selector: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Finds the `@` that separates selector from attribute.
 *
 * A naive `lastIndexOf('@')` is wrong: `a[href^="mailto:contact@example.com"]` is a
 * perfectly valid selector containing an `@`. Only an `@` at bracket depth zero and
 * outside any quoted string separates the two halves.
 *
 * @returns the index of the separator, or -1 when there is none.
 */
function findAttributeSeparator(spec: string): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < spec.length; i += 1) {
    const char = spec[i]!;

    if (quote !== null) {
      if (char === '\\') {
        i += 1; // skip the escaped character
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === ')') {
      depth -= 1;
    } else if (char === '@' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Parses one `[selector][@attribute]` field spec. Throws on an unusable spec. */
export function parseFieldSpec(spec: string): FieldSpec {
  const trimmed = spec.trim();
  if (trimmed === '') throw new Error('parseFieldSpec: empty field spec');

  const separator = findAttributeSeparator(trimmed);
  if (separator === -1) {
    return { selector: trimmed, attribute: TEXT_PSEUDO_ATTRIBUTE };
  }

  const selector = trimmed.slice(0, separator).trim();
  const attribute = trimmed.slice(separator + 1).trim();

  if (attribute === '') {
    throw new Error(`parseFieldSpec: "${spec}" ends with "@" but names no attribute`);
  }

  return { selector: selector === '' ? null : selector, attribute };
}

/** Parses every field of an extract spec, failing with the field name on error. */
export function parseExtractSpec(spec: ExtractSpec): Map<string, FieldSpec> {
  if (spec.selector.trim() === '') {
    throw new Error('parseExtractSpec: selector is required');
  }
  const parsed = new Map<string, FieldSpec>();
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    try {
      parsed.set(name, parseFieldSpec(fieldSpec));
    } catch (error) {
      throw new Error(
        `parseExtractSpec: field "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return parsed;
}

/**
 * Normalises extracted text the way a reader perceives it: collapsed runs of
 * whitespace, trimmed ends. Without this, the same visible title yields different
 * strings depending on the source formatting — and therefore a different content
 * hash on every reformatting of the page.
 */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
