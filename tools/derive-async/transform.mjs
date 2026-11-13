import { dirname, join, relative } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { ModifierFlags } from 'typescript/unstable/sync';
import { lineOf } from './analyze.mjs';

const PASSING = new Set([SyntaxKind.ParenthesizedExpression]);

function awaited(node) {
  let at = node.parent;
  while (at && PASSING.has(at.kind)) at = at.parent;
  return at?.kind === SyntaxKind.AwaitExpression;
}

function asyncAt(fn, text) {
  const node = fn.node;
  if (node.kind === SyntaxKind.ArrowFunction) return node.getStart();
  if (node.kind === SyntaxKind.MethodDeclaration) return node.name.getStart();
  const from = node.modifiers?.length ? node.modifiers.end : node.getStart();
  const at = text.indexOf('function', from);
  if (at < 0) throw new Error(`derive-async: no function keyword at ${lineOf(node).file}`);
  return at;
}

function importPath(file, target) {
  const path = relative(dirname(file), target).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}

function check(text, node) {
  if (text.slice(node.getStart(), node.end) !== node.getText()) {
    const at = lineOf(node);
    throw new Error(`derive-async: offsets disagree at ${at.file}:${at.line}`);
  }
}

class Edits {
  constructor() {
    this.byFile = new Map();
  }

  of(node) {
    const file = node.getSourceFile().fileName;
    let list = this.byFile.get(file);
    if (!list) this.byFile.set(file, (list = { inserts: [], helpers: new Set() }));
    return list;
  }

  insert(node, at, text, open, span = node.end - node.getStart()) {
    this.of(node).inserts.push({ at, text, open, span });
  }

  replace(node, start, end, text) {
    this.of(node).inserts.push({ at: start, end, text, open: true, span: 0 });
  }

  wrap(node, before, after) {
    this.insert(node, node.getStart(), before, true);
    this.insert(node, node.end, after, false);
  }

  helper(node, name) {
    this.of(node).helpers.add(name);
  }

  apply(sources, runtime) {
    const out = new Map();
    for (const [file, { inserts, helpers }] of this.byFile) {
      let text = sources.get(file).text;
      inserts.sort(
        (a, b) =>
          b.at - a.at ||
          Number(b.open) - Number(a.open) ||
          (a.open ? a.span - b.span : b.span - a.span)
      );
      for (const ins of inserts) {
        text = text.slice(0, ins.at) + ins.text + text.slice(ins.end ?? ins.at);
      }
      if (helpers.size > 0) {
        const names = [...helpers].sort().join(', ');
        text = `import { ${names} } from '${importPath(file, runtime)}';\n${text}`;
      }
      out.set(file, text);
    }
    return out;
  }
}

function asyncFunction(edits, fn, { root, config }) {
  const sf = fn.node.getSourceFile();
  check(sf.text, fn.node);
  edits.insert(fn.node, asyncAt(fn, sf.text), 'async ', true, -1);
  if (!config.trace || fn.node.body.kind !== SyntaxKind.Block) return;
  const at = lineOf(fn.node);
  const tag = JSON.stringify(`${relative(root, at.file)}:${at.line}`);
  const body = fn.node.body;
  edits.insert(body, body.getStart() + 1, `globalThis.__deriveTrace?.(${tag});`, true, -2);
}

function rewriteCall(edits, call, rules) {
  const node = call.node;
  if (node.expression.kind === SyntaxKind.ImportKeyword && rules.importCalls) {
    edits.replace(node, node.expression.getStart(), node.expression.end, rules.importCalls);
    edits.helper(node, rules.importCalls);
    return undefined;
  }
  const replace = call.lib !== undefined ? rules.replaced.get(call.lib) : undefined;
  if (replace) {
    check(node.getSourceFile().text, node.expression);
    edits.replace(node, node.getStart(), node.expression.end, replace.with);
    edits.helper(node, replace.with);
  }
  const wrap = call.lib !== undefined ? rules.wrapped.get(call.lib) : undefined;
  const arg = wrap && node.arguments?.[wrap.argument];
  if (arg) {
    edits.wrap(arg, `${wrap.with}(`, ')');
    edits.helper(node, wrap.with);
  }
  return replace;
}

export function derive(analysis, { root, config }) {
  const edits = new Edits();
  let functions = 0;
  let awaits = 0;
  for (const fn of analysis.functions.values()) {
    if (!fn.tainted || fn.async || !analysis.isLive(fn.node)) continue;
    if (fn.node.modifierFlags & ModifierFlags.Async) continue;
    asyncFunction(edits, fn, { root, config });
    functions++;
  }
  const rules = {
    importCalls: config.importCalls,
    replaced: new Map(config.replaceCalls.map((r) => [r.lib, r])),
    wrapped: new Map(config.wrapArguments.map((r) => [r.lib, r])),
  };
  for (const call of analysis.calls) {
    if (!analysis.isLive(call.node)) continue;
    const replace = rewriteCall(edits, call, rules);
    const node = call.node;
    const blocking = call.tainted || replace?.await;
    if (!blocking || awaited(node) || node.kind === SyntaxKind.NewExpression) continue;
    check(node.getSourceFile().text, node);
    edits.wrap(node, '(await ', ')');
    awaits++;
  }
  const files = edits.apply(analysis.sources, join(root, config.runtime));
  return { files, functions, awaits };
}
