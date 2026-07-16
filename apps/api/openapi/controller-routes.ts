import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const HTTP_DECORATORS = new Set(['Delete', 'Get', 'Patch', 'Post', 'Put']);

export function readControllerRoutes(apiSourceDirectory: string): readonly string[] {
  const files = findControllerFiles(apiSourceDirectory);
  const routes: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const controller = (ts.getDecorators(statement) ?? [])
        .map(readDecorator)
        .find((decorator) => decorator?.name === 'Controller');
      if (!controller) continue;
      for (const member of statement.members) {
        const route = (ts.getDecorators(member) ?? [])
          .map(readDecorator)
          .find((decorator) => decorator && HTTP_DECORATORS.has(decorator.name));
        if (!route) continue;
        const routePath = [controller.argument, route.argument]
          .filter(Boolean)
          .join('/')
          .replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
        routes.push(`${route.name.toUpperCase()} /${routePath}`);
      }
    }
  }
  return routes.sort();
}

function findControllerFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findControllerFiles(fullPath));
    else if (entry.name.endsWith('.controller.ts')) files.push(fullPath);
  }
  return files;
}

function readDecorator(
  decorator: ts.Decorator,
): { readonly argument: string; readonly name: string } | undefined {
  const expression = decorator.expression;
  if (ts.isIdentifier(expression)) return { argument: '', name: expression.text };
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
    return undefined;
  }
  const argument = expression.arguments[0];
  return {
    argument: argument && ts.isStringLiteral(argument) ? argument.text : '',
    name: expression.expression.text,
  };
}
