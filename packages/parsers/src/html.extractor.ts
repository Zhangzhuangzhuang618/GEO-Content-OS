import { parse, type DefaultTreeAdapterTypes as HtmlTree } from 'parse5';

import { normalizeText, type ExtractedUnit } from './normalization.js';

const IGNORED_TAGS = new Set(['canvas', 'noscript', 'script', 'style', 'svg', 'template']);
const UNIT_TAGS = new Set(['blockquote', 'dd', 'dt', 'figcaption', 'li', 'p', 'pre']);

export interface HtmlExtractionResult {
  readonly units: readonly ExtractedUnit[];
  readonly usedMainContent: boolean;
}

export function extractHtmlUnits(html: string, url: string | null): HtmlExtractionResult {
  const document = parse(html);
  const main = findFirstElement(document, new Set(['main', 'article']));
  const root = main ?? findFirstElement(document, new Set(['body'])) ?? document;
  const headings: string[] = [];
  const units: ExtractedUnit[] = [];
  walk(root, headings, units, url);
  if (units.length === 0) {
    const fallback = normalizeText(textContent(root));
    if (fallback) units.push({ headings: [], text: fallback, url });
  }
  return { units: Object.freeze(units), usedMainContent: Boolean(main) };
}

function walk(
  node: HtmlTree.Node,
  headings: string[],
  units: ExtractedUnit[],
  url: string | null,
): void {
  if (isElement(node)) {
    const tag = node.tagName.toLowerCase();
    if (IGNORED_TAGS.has(tag)) return;
    if (/^h[1-6]$/u.test(tag)) {
      const text = normalizeText(textContent(node));
      if (!text) return;
      const level = Number(tag.slice(1));
      headings.splice(level - 1);
      headings[level - 1] = text;
      headings.splice(level);
      units.push({ headings: compactHeadings(headings), text, url });
      return;
    }
    if (tag === 'table') {
      extractTableRows(node, headings, units, url);
      return;
    }
    if (UNIT_TAGS.has(tag)) {
      const text = normalizeText(textContent(node));
      if (text) units.push({ headings: compactHeadings(headings), text, url });
      return;
    }
  }
  for (const child of childNodes(node)) walk(child, headings, units, url);
}

function extractTableRows(
  table: HtmlTree.Element,
  headings: readonly string[],
  units: ExtractedUnit[],
  url: string | null,
): void {
  for (const row of findElements(table, 'tr')) {
    const cells = childNodes(row)
      .filter(
        (node): node is HtmlTree.Element =>
          isElement(node) && ['td', 'th'].includes(node.tagName.toLowerCase()),
      )
      .map((cell) => normalizeText(textContent(cell)))
      .filter(Boolean);
    if (cells.length > 0) {
      units.push({ headings: compactHeadings(headings), text: cells.join(' | '), url });
    }
  }
}

function compactHeadings(headings: readonly string[]): string[] {
  return headings.filter((heading) => typeof heading === 'string' && heading.length > 0);
}

function textContent(node: HtmlTree.Node): string {
  if (isTextNode(node)) return node.value;
  if (isElement(node) && IGNORED_TAGS.has(node.tagName.toLowerCase())) return '';
  const separator = isElement(node) && node.tagName.toLowerCase() === 'br' ? '\n' : '';
  return separator + childNodes(node).map(textContent).join('');
}

function findFirstElement(
  node: HtmlTree.Node,
  tags: ReadonlySet<string>,
): HtmlTree.Element | undefined {
  if (isElement(node) && tags.has(node.tagName.toLowerCase())) return node;
  for (const child of childNodes(node)) {
    const match = findFirstElement(child, tags);
    if (match) return match;
  }
  return undefined;
}

function findElements(node: HtmlTree.Node, tag: string): HtmlTree.Element[] {
  const matches: HtmlTree.Element[] = [];
  for (const child of childNodes(node)) {
    if (isElement(child) && child.tagName.toLowerCase() === tag) matches.push(child);
    matches.push(...findElements(child, tag));
  }
  return matches;
}

function childNodes(node: HtmlTree.Node): HtmlTree.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function isElement(node: HtmlTree.Node): node is HtmlTree.Element {
  return 'tagName' in node;
}

function isTextNode(node: HtmlTree.Node): node is HtmlTree.TextNode {
  return node.nodeName === '#text' && 'value' in node;
}
