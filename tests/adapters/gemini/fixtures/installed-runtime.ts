import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

interface Provenance {
  version: string;
  files: Record<string, string>;
}
const parse = (source: string) =>
  ts.createSourceFile(
    "runtime.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
function dynamicMain(source: string): string {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some((element) => element.name.getText() === "main") &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer)
    ) {
      const expression = node.initializer.expression;
      if (
        ts.isCallExpression(expression) &&
        expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
        expression.arguments.length === 1 &&
        ts.isStringLiteral(expression.arguments[0]!)
      )
        found = expression.arguments[0]!.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  if (!found) throw new Error("Cannot bind the executable dynamic main import");
  return found;
}
function namedImport(source: string, symbol: string): string {
  const declarations = parse(source).statements.filter(ts.isImportDeclaration);
  const found = declarations.find((declaration) => {
    const bindings = declaration.importClause?.namedBindings;
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) => (element.propertyName ?? element.name).text === symbol,
      )
    );
  });
  if (!found || !ts.isStringLiteral(found.moduleSpecifier))
    throw new Error(`Cannot bind actual runtime import ${symbol}`);
  return found.moduleSpecifier.text;
}
/** Read the installed bin/import edges without executing CLI startup or main(). */
export async function resolveInstalledRuntime(bundle: string) {
  const root = await realpath(bundle);
  const manifest = JSON.parse(
    await readFile(join(dirname(root), "package.json"), "utf8"),
  ) as { version: string; bin: { gemini: string } };
  const expected = JSON.parse(
    await readFile(
      new URL("./gemini-0.56.0-runtime-provenance.json", import.meta.url),
      "utf8",
    ),
  ) as Provenance;
  if (manifest.version !== expected.version)
    throw new Error("Installed Gemini version is outside the source contract");
  const hashes: Record<string, string> = {};
  const read = async (
    name: string,
  ): Promise<{ path: string; source: string }> => {
    const path = await realpath(resolve(root, name));
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || !rel.endsWith(".js"))
      throw new Error("Runtime module escapes installed bundle");
    const source = await readFile(path, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    if (expected.files[rel] !== hash)
      throw new Error(`Runtime source digest mismatch: ${rel}`);
    hashes[rel] = hash;
    return { path, source };
  };
  const entry = await read(
    relative(root, resolve(dirname(root), manifest.bin.gemini)),
  );
  const main = await read(dynamicMain(entry.source));
  const core = await read(namedImport(main.source, "createPolicyEngineConfig"));
  if (
    namedImport(main.source, "Config") !==
    namedImport(main.source, "createPolicyEngineConfig")
  )
    throw new Error(
      "Policy and Config imports do not share actual engine identity",
    );
  const settings = await read(namedImport(main.source, "loadSettings"));
  if (resolve(root, namedImport(settings.source, "Storage")) !== core.path)
    throw new Error(
      "Settings and CLI use distinct runtime Storage implementations",
    );
  // The executable's preload must bind the same core source, not a sibling stale chunk.
  if (
    !parse(entry.source)
      .statements.filter(ts.isImportDeclaration)
      .some(
        (statement) =>
          ts.isStringLiteral(statement.moduleSpecifier) &&
          resolve(root, statement.moduleSpecifier.text) === core.path,
      )
  )
    throw new Error("Executable preloads a different core");
  if (Object.keys(hashes).length !== Object.keys(expected.files).length)
    throw new Error("Runtime source provenance is incomplete");
  return {
    entry: entry.path,
    main: main.path,
    core: core.path,
    settings: settings.path,
    hashes,
  };
}
