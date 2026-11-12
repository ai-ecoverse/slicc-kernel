import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { SyntaxKind } from 'typescript/unstable/ast';
import { Analysis } from './analyze.mjs';
import { derive } from './transform.mjs';

export async function closure(root, entries) {
  const result = await build({
    entryPoints: entries.map((e) => join(root, e)),
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    absWorkingDir: root,
  });
  return Object.keys(result.metafile.inputs)
    .filter((f) => f.startsWith('src/') && f.endsWith('.ts'))
    .map((f) => resolve(root, f))
    .sort();
}

function findChild(node, test) {
  let found;
  const visit = (n) => {
    if (found) return;
    if (test(n)) {
      found = n;
      return;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
}

const named = (name) => (n) => n.name?.kind === SyntaxKind.Identifier && n.name.text === name;

export function memberSeed(file, owner, member) {
  return {
    file,
    find: (sf) => {
      const decl = findChild(
        sf,
        (n) =>
          (n.kind === SyntaxKind.InterfaceDeclaration || n.kind === SyntaxKind.ClassDeclaration) &&
          named(owner)(n)
      );
      return decl && findChild(decl, (n) => n !== decl && named(member)(n));
    },
  };
}

export function typeSeed(file, name) {
  return {
    file,
    find: (sf) => {
      const decl = findChild(
        sf,
        (n) =>
          (n.kind === SyntaxKind.VariableDeclaration ||
            n.kind === SyntaxKind.TypeAliasDeclaration ||
            n.kind === SyntaxKind.FunctionDeclaration) &&
          named(name)(n)
      );
      if (!decl) return undefined;
      if (decl.kind === SyntaxKind.FunctionDeclaration) return decl;
      return findChild(decl.type, (n) => n.kind === SyntaxKind.FunctionType);
    },
  };
}

export function returnSeed(file, name) {
  return {
    file,
    find: (sf) => {
      const decl = findChild(
        sf,
        (n) => n.kind === SyntaxKind.FunctionDeclaration && named(name)(n)
      );
      return decl?.type && findChild(decl.type, (n) => n.kind === SyntaxKind.FunctionType);
    },
  };
}

export function analyze({ root, files, config }) {
  const analysis = new Analysis({
    root,
    tsconfig: join(root, 'tsconfig.json'),
    files,
    entries: config.entries.map((e) => join(root, e)),
    seeds: {
      lib: new Set(config.libSeeds),
      source: config.sourceSeeds.map((s) => ({ ...s, file: join(root, s.file) })),
      asyncCallbacks: new Set(config.asyncCallbacks),
      lostInto: new Set(config.lostInto ?? []),
      forwarders: (config.forwarders ?? []).map((f) => ({ ...f, file: join(root, f.file) })),
    },
  });
  const report = analysis.run();
  return { analysis, report };
}

export function rel(root, file) {
  return relative(root, file);
}

export function readSource(file) {
  return readFileSync(file, 'utf8');
}

export class DeriveError extends Error {
  constructor(problems) {
    super(
      `derive-async: the async variant cannot be derived:\n${problems.map((p) => `  ${p.text}`).join('\n')}`
    );
    this.problems = problems;
  }
}

export async function deriveAsync({ root, config }) {
  const files = await closure(root, config.entries);
  const { analysis, report } = analyze({ root, files, config });
  try {
    if (report.errors.length > 0) throw new DeriveError(report.errors);
    const derived = derive(analysis, { root, config });
    for (const [file, text] of Object.entries(config.overrides ?? {})) {
      derived.files.set(join(root, file), text);
    }
    return { ...derived, closure: files, warnings: report.warnings };
  } finally {
    analysis.close();
  }
}

export function derivedPlugin(derived) {
  return {
    name: 'derive-async',
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        const text = derived.files.get(args.path);
        return text === undefined ? undefined : { contents: text, loader: 'ts' };
      });
    },
  };
}
