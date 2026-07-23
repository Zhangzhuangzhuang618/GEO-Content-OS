import { readFileSync, readdirSync, readFileSync as readSourceFile } from 'node:fs';
import { extname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { middleware } from '../../src/middleware';

interface SecurityCase {
  readonly category: string;
  readonly expected: string;
  readonly id: string;
  readonly input?: string;
}

const MATRIX = loadMatrix();

describe('T138 Web XSS matrix', () => {
  it.each(casesFor('xss'))('$id escapes untrusted text during server rendering', (securityCase) => {
    const input = requireInput(securityCase);
    const markup = renderToStaticMarkup(createElement('article', null, input));

    expect(securityCase.expected).toBe('escaped');
    expect(markup).not.toContain(input);
    expect(markup).not.toMatch(/<(?:script|img)\b/iu);
    expect(markup).toContain('&lt;');
  });

  it('keeps executable DOM sinks out of application source', () => {
    const sourceFiles = listSourceFiles(new URL('../../src', import.meta.url));
    const forbidden = /dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\s*\(|\bnew\s+Function\s*\(/u;
    const findings = sourceFiles.filter((path) => forbidden.test(readSourceFile(path, 'utf8')));

    expect(findings).toEqual([]);
  });

  it('does not reflect an XSS query into headers and keeps nonce-only script policy', () => {
    const attack = requireInput(casesFor('xss')[0]!);
    const response = middleware(
      new NextRequest(`https://app.example.com/search?q=${encodeURIComponent(attack)}`),
    );
    const headers = JSON.stringify(Object.fromEntries(response.headers.entries()));
    const csp = response.headers.get('content-security-policy');

    expect(headers).not.toContain(attack);
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toContain("'unsafe-inline'");
  });
});

function loadMatrix(): readonly SecurityCase[] {
  const path = new URL(
    '../../../../packages/testkit/security/security-matrix.json',
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly cases?: readonly SecurityCase[];
    readonly schema_version?: string;
  };
  if (parsed.schema_version !== '1.0' || !Array.isArray(parsed.cases)) {
    throw new Error('T138 security matrix is invalid');
  }
  return parsed.cases;
}

function casesFor(category: string): readonly SecurityCase[] {
  const cases = MATRIX.filter((entry) => entry.category === category);
  if (cases.length === 0) throw new Error(`Missing security category ${category}`);
  return cases;
}

function requireInput(securityCase: SecurityCase): string {
  if (!securityCase.input) throw new Error(`Security case ${securityCase.id} has no input`);
  return securityCase.input;
}

function listSourceFiles(root: URL): readonly string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root.pathname, entry.name);
    if (entry.isDirectory()) paths.push(...listSourceFiles(new URL(`${path}/`, 'file:')));
    else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.includes('.test.')) {
      paths.push(path);
    }
  }
  return paths;
}
