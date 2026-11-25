import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const defaultRoot = fileURLToPath(new URL('../src/', import.meta.url))

// Use the TypeScript syntax tree so comments, type-only edges and dynamic imports
// cannot accidentally hide a runtime cycle or create a false one.
function imports(source, file) {
  if (file.endsWith('.vue'))
    source = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .join('\n')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const edges = []
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const typesOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((item) => item.isTypeOnly))
      edges.push({ specifier: node.moduleSpecifier.text, runtime: !typesOnly })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named = node.exportClause
      const typesOnly =
        node.isTypeOnly ||
        (named && ts.isNamedExports(named) && named.elements.every((item) => item.isTypeOnly))
      edges.push({ specifier: node.moduleSpecifier.text, runtime: !typesOnly })
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      edges.push({ specifier: node.arguments[0].text, runtime: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return edges
}

export async function checkSourceBoundaries(root = defaultRoot) {
  const files = new Map()
  async function collect(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'assets') continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await collect(file)
      else if (/\.(?:ts|vue)$/.test(entry.name)) files.set(file, await readFile(file, 'utf8'))
    }
  }
  await collect(root)
  const failures = [],
    graph = new Map()
  const relative = (file) => path.relative(root, file).split(path.sep).join('/')
  for (const [file, source] of files) {
    const name = relative(file)
    if (!name.includes('/') && !['main.ts', 'App.vue', 'vue-shim.d.ts'].includes(name))
      failures.push(`${name}: place implementation in app, features, infrastructure or shared`)
    const edges = []
    for (const { specifier, runtime } of imports(source, file)) {
      if (!specifier.startsWith('.')) continue
      const base = path.resolve(path.dirname(file), specifier)
      const target = [base, base + '.ts', base + '.vue', path.join(base, 'index.ts')].find(
        (candidate) => files.has(candidate),
      )
      if (!target) continue // CSS, JSON and bundled assets are resolved by Vite.
      const dependency = relative(target)
      if (
        (name.startsWith('shared/') && /^(app|features|infrastructure)\//.test(dependency)) ||
        (name.startsWith('infrastructure/') && /^(app|features)\//.test(dependency))
      )
        failures.push(`${name}: forbidden dependency on ${dependency}`)
      if (runtime) edges.push(target)
    }
    graph.set(file, edges)
  }
  const active = new Set(),
    visited = new Set(),
    stack = []
  function walk(file) {
    if (active.has(file)) {
      failures.push(
        'Runtime cycle: ' + [...stack.slice(stack.indexOf(file)), file].map(relative).join(' → '),
      )
      return
    }
    if (visited.has(file)) return
    visited.add(file)
    active.add(file)
    stack.push(file)
    for (const target of graph.get(file) || []) walk(target)
    stack.pop()
    active.delete(file)
  }
  for (const file of files.keys()) walk(file)
  return failures
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await checkSourceBoundaries()
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else console.log('Frontend boundaries passed; no runtime import cycles.')
}
