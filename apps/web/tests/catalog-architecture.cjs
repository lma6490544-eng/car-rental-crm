const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const parse = (filename) =>
  ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);

test('catalog facade retains all twelve public exports', () => {
  const facade = parse(path.join(root, 'catalog.tsx'));
  const names = facade.statements.flatMap((node) =>
    ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
      ? node.exportClause.elements.map((element) => element.name.text)
      : [],
  );
  assert.deepEqual(
    names.sort(),
    [
      'bodyNames',
      'Customer',
      'Vehicle',
      'Model',
      'transmissionNames',
      'useListScroll',
      'usePolling',
      'PollNotice',
      'VehicleTags',
      'CommandModal',
      'dateText',
      'History',
    ].sort(),
  );
});

test('frontend relative imports have no cycles, including type-only edges', () => {
  const files = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(filename);
      else if (/\.tsx?$/.test(entry.name)) files.push(filename);
    }
  };
  collect(root);
  const graph = new Map();
  for (const filename of files) {
    const dependencies = [];
    const resolve = (specifier) => {
      if (!specifier.startsWith('.')) return;
      const base = path.resolve(path.dirname(filename), specifier);
      const target = [
        base,
        base + '.ts',
        base + '.tsx',
        path.join(base, 'index.ts'),
        path.join(base, 'index.tsx'),
      ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (target && /\.tsx?$/.test(target)) dependencies.push(target);
    };
    const visit = (node) => {
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        resolve(node.argument.literal.text);
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        resolve(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      )
        resolve(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(parse(filename));
    graph.set(filename, dependencies);
  }
  const visited = new Set();
  const stack = [];
  const visit = (filename) => {
    assert.ok(
      !stack.includes(filename),
      'Import cycle: ' + [...stack, filename].map((file) => path.relative(root, file)).join(' -> '),
    );
    if (visited.has(filename)) return;
    stack.push(filename);
    for (const dependency of graph.get(filename) ?? []) visit(dependency);
    stack.pop();
    visited.add(filename);
  };
  for (const filename of files) visit(filename);
});
