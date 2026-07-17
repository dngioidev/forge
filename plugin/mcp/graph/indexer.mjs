/**
 * Structural indexer (spec §9; SP8 T2). ts-morph is resolved lazily FROM THE
 * CONSUMER REPO — forge itself ships no runtime dependencies; a TS project is
 * where TS tooling lives. Non-TS repos never index: librarian stays grep-first
 * and scoper import-scan, permanently (spec §9 — a fallback, not a stopgap).
 *
 * Heuristics (documented, deliberately simple):
 *  - component = exported function/class with an uppercase-first name declared
 *    in a .tsx/.jsx file
 *  - props-interface = interface/type alias named *Props
 *  - file kind: *.test.*|*.spec.* -> test, *.stories.* -> story, else file
 *  - edge kind follows the importer: test -> tests, story -> documents,
 *    else imports; renders = JSX tags resolved to known components
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { upsertNode, upsertEdge, deleteFileScope, resetDb } from './db.mjs';

export function fileKind(rel) {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return 'test';
  if (/\.stories\.[cm]?[jt]sx?$/.test(rel)) return 'story';
  return 'file';
}

export function edgeKindFor(importerKind) {
  return importerKind === 'test' ? 'tests' : importerKind === 'story' ? 'documents' : 'imports';
}

const posix = (p) => p.split('\\').join('/');

export async function loadTsMorph(cwd) {
  try {
    const req = createRequire(join(cwd, 'package.json'));
    return { ok: true, tsMorph: req('ts-morph') };
  } catch {
    return {
      ok: false,
      error:
        'ts-morph is not resolvable from this repo — the graph indexes TypeScript projects only. ' +
        'TS repo: `npm i -D ts-morph` (or pnpm/yarn) and re-run. ' +
        'Non-TS repo: leave features.graph off — librarian works grep-first and scoper import-scans; ' +
        'that fallback is permanent, not a stopgap (spec §9).',
    };
  }
}

export async function makeProject(cwd) {
  const loaded = await loadTsMorph(cwd);
  if (!loaded.ok) return loaded;
  const { Project } = loaded.tsMorph;
  const tsconfig = join(cwd, 'tsconfig.json');
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig })
    : new Project({ compilerOptions: { allowJs: false, jsx: 2 /* React */ } });
  if (!existsSync(tsconfig)) project.addSourceFilesAtPaths([join(cwd, '**/*.{ts,tsx}'), '!**/node_modules/**']);
  return { ok: true, project, tsMorph: loaded.tsMorph };
}

function relOf(cwd, sourceFile) {
  return posix(relative(cwd, sourceFile.getFilePath()));
}

/** Index one ts-morph SourceFile into the db. Returns node/edge tallies. */
export function indexSourceFile(db, cwd, sf) {
  const rel = relOf(cwd, sf);
  const kind = fileKind(rel);
  deleteFileScope(db, rel);
  upsertNode(db, { id: `file:${rel}`, kind, name: rel, file: rel });

  const componentNames = new Set();
  const importedFrom = new Map(); // local name -> imported file rel

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile();
    if (!target || target.isInNodeModules()) continue;
    const targetRel = relOf(cwd, target);
    upsertEdge(db, { src: `file:${rel}`, dst: `file:${targetRel}`, kind: edgeKindFor(kind) });
    for (const named of imp.getNamedImports()) importedFrom.set(named.getName(), targetRel);
    const def = imp.getDefaultImport();
    if (def) importedFrom.set(def.getText(), targetRel);
  }

  const isComponentFile = /\.[jt]sx$/.test(rel);
  for (const [name, decls] of sf.getExportedDeclarations()) {
    const decl = decls[0];
    if (!decl) continue;
    const declKind = decl.getKindName();
    upsertNode(db, { id: `export:${rel}#${name}`, kind: 'export', name, file: rel, meta: { declKind } });
    const isCallable = /FunctionDeclaration|ArrowFunction|ClassDeclaration|VariableDeclaration/.test(declKind);
    if (isComponentFile && isCallable && /^[A-Z]/.test(name)) {
      upsertNode(db, { id: `component:${rel}#${name}`, kind: 'component', name, file: rel });
      componentNames.add(name);
    }
    if (/InterfaceDeclaration|TypeAliasDeclaration/.test(declKind) && /Props$/.test(name)) {
      const members = typeof decl.getMembers === 'function'
        ? decl.getMembers().map((m) => (typeof m.getName === 'function' ? m.getName() : null)).filter(Boolean)
        : [];
      upsertNode(db, { id: `props:${rel}#${name}`, kind: 'props-interface', name, file: rel, meta: { members } });
    }
  }

  // renders: JSX tags inside this file resolved to local or imported components
  if (isComponentFile && componentNames.size > 0) {
    const tags = new Set();
    // kind-name match, not SyntaxKind numbers — those shift between TS versions
    for (const el of sf.getDescendants()) {
      if (!/^Jsx(OpeningElement|SelfClosingElement)$/.test(el.getKindName())) continue;
      const tag = el.getTagNameNode().getText();
      if (/^[A-Z]/.test(tag)) tags.add(tag);
    }
    for (const src of componentNames) {
      for (const tag of tags) {
        if (tag === src) continue;
        const targetRel = componentNames.has(tag) ? rel : importedFrom.get(tag);
        if (targetRel) upsertEdge(db, { src: `component:${rel}#${src}`, dst: `component:${targetRel}#${tag}`, kind: 'renders' });
      }
    }
  }
  return rel;
}

export async function rebuild(db, cwd) {
  const made = await makeProject(cwd);
  if (!made.ok) return made;
  resetDb(db); // ticket edges are re-derived by graphctl tickets after a rebuild
  const files = made.project.getSourceFiles().filter((sf) => !sf.isInNodeModules() && !sf.isDeclarationFile());
  for (const sf of files) indexSourceFile(db, cwd, sf);
  return { ok: true, files: files.length };
}

export async function indexFiles(db, cwd, paths) {
  const made = await makeProject(cwd);
  if (!made.ok) return made;
  let n = 0;
  for (const p of paths) {
    const sf = made.project.getSourceFile(join(cwd, p)) ?? made.project.addSourceFileAtPathIfExists(join(cwd, p));
    if (!sf) { deleteFileScope(db, posix(p)); continue; } // deleted file: drop its rows
    indexSourceFile(db, cwd, sf);
    n++;
  }
  return { ok: true, files: n };
}
