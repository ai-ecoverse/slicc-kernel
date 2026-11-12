import { SyntaxKind } from 'typescript/unstable/ast';
import {
  API,
  ModifierFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
} from 'typescript/unstable/sync';

const FUNCTIONS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

const SYNC_ONLY = new Map([
  [SyntaxKind.Constructor, 'a constructor'],
  [SyntaxKind.GetAccessor, 'a getter'],
  [SyntaxKind.SetAccessor, 'a setter'],
]);

const UNWRAPPED = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.SatisfiesExpression,
]);

const LOGICAL = new Set([
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.AmpersandAmpersandToken,
]);

const PRIMITIVE =
  TypeFlags.String |
  TypeFlags.Number |
  TypeFlags.BigInt |
  TypeFlags.Boolean |
  TypeFlags.ESSymbol |
  TypeFlags.StringLiteral |
  TypeFlags.NumberLiteral |
  TypeFlags.BigIntLiteral |
  TypeFlags.BooleanLiteral |
  TypeFlags.EnumLiteral |
  TypeFlags.Enum |
  TypeFlags.Void |
  TypeFlags.Undefined |
  TypeFlags.Null |
  TypeFlags.Never |
  TypeFlags.TemplateLiteral;

const keyOf = (node) => `${node.getSourceFile().path}#${node.index}`;
const handleKey = (handle) => `${handle.path}#${handle.index}`;

export function isLibPath(path) {
  return (
    /\/node_modules\/(typescript|@typescript|@types)\//.test(path) ||
    /\/lib\.[^/]*\.d\.ts$/.test(path)
  );
}

function qualifiedName(node) {
  const parts = [];
  for (let at = node; at && at.kind !== SyntaxKind.SourceFile; at = at.parent) {
    const name = at.name;
    if (name && name.kind === SyntaxKind.Identifier) parts.unshift(name.text);
  }
  return parts.join('.');
}

export function lineOf(node) {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: line + 1, column: character + 1 };
}

function identifiers(statements) {
  const ids = [];
  const visit = (n) => {
    if (n.kind === SyntaxKind.Identifier) ids.push(n);
    n.forEachChild(visit);
  };
  for (const statement of statements) visit(statement);
  return ids;
}

function flowOf(node) {
  switch (node.kind) {
    case SyntaxKind.PropertyAssignment:
      return node.initializer && { expr: node.initializer, site: 'property' };
    case SyntaxKind.ShorthandPropertyAssignment:
      return { expr: node.name, site: 'shorthand', member: node };
    case SyntaxKind.MethodDeclaration:
      return node.parent.kind === SyntaxKind.ObjectLiteralExpression
        ? { expr: node, site: 'method', member: node }
        : undefined;
    case SyntaxKind.ReturnStatement:
      return node.expression && { expr: node.expression, site: 'return' };
    case SyntaxKind.ArrowFunction:
      return node.body && node.body.kind !== SyntaxKind.Block
        ? { expr: node.body, site: 'return' }
        : undefined;
    case SyntaxKind.VariableDeclaration:
      return node.initializer && node.type && { expr: node.initializer, site: 'variable' };
    case SyntaxKind.PropertyDeclaration:
      return node.initializer && { expr: node.initializer, site: 'field' };
    case SyntaxKind.Parameter:
      return node.initializer && { expr: node.initializer, site: 'default' };
    case SyntaxKind.BinaryExpression:
      return node.operatorToken.kind === SyntaxKind.EqualsToken
        ? { expr: node.right, site: 'assignment' }
        : undefined;
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      return { expr: node.expression, site: 'cast', target: node };
    default:
      return undefined;
  }
}

function where(node) {
  const at = lineOf(node);
  return `${at.file}:${at.line}:${at.column}`;
}

export class Analysis {
  constructor({ root, tsconfig, files, entries, seeds }) {
    this.root = root;
    this.entries = entries;
    this.api = new API({ cwd: root });
    const snapshot = this.api.updateSnapshot({ openProject: tsconfig });
    this.project = snapshot.getProjects()[0];
    this.checker = this.project.checker;
    this.files = files;
    this.seeds = seeds;
    this.functions = new Map();
    this.calls = [];
    this.edges = new Map();
    this.libCallbacks = [];
    this.declNames = new Map();
    this.sigCache = new Map();
    this.memberwise = new Set();
    this.unresolved = [];
    this.topLevel = [];
    this.fields = [];
    this.libDecls = new Map();
    this.sources = new Map();
    this.lost = [];
    this.opaque = [];
  }

  close() {
    this.api.close();
  }

  sourceFile(file) {
    return this.project.program.getSourceFile(file);
  }

  run() {
    for (const file of this.files) {
      const sf = this.sourceFile(file);
      if (!sf) throw new Error(`derive-async: ${file} is not in the TypeScript project`);
      this.sources.set(file, sf);
      this.collect(sf);
    }
    this.reach();
    this.resolveCalls();
    this.resolveFlows();
    this.forwarded();
    this.propagate();
    return this.report();
  }

  collect(sf) {
    this.pendingFlows ??= [];
    const visit = (node, fn) => {
      const inner = this.scopeOf(node, fn);
      this.noteNode(node, inner);
      node.forEachChild((child) => visit(child, inner));
    };
    visit(sf, undefined);
  }

  scopeOf(node, fn) {
    const kind = node.kind;
    if (FUNCTIONS.has(kind) && node.body) {
      const scope = {
        key: keyOf(node),
        node,
        kind,
        async: (node.modifierFlags & ModifierFlags.Async) !== 0,
        generator: node.asteriskToken !== undefined,
        calls: [],
      };
      this.functions.set(scope.key, scope);
      return scope;
    }
    const field =
      (kind === SyntaxKind.PropertyDeclaration && node.initializer) ||
      kind === SyntaxKind.ClassStaticBlockDeclaration;
    if (!field) return fn;
    const scope = { key: keyOf(node), node, kind, field: true, calls: [] };
    this.fields.push(scope);
    return scope;
  }

  noteNode(node, fn) {
    const flows = this.pendingFlows;
    const kind = node.kind;
    if (kind === SyntaxKind.CallExpression || kind === SyntaxKind.NewExpression) {
      const call = { node, fn, callees: new Set(), lib: undefined };
      this.calls.push(call);
      (fn ? fn.calls : this.topLevel).push(call);
      for (const [index, arg] of (node.arguments ?? []).entries()) {
        flows.push({ expr: arg, site: 'argument', call, index });
      }
      return;
    }
    if (kind === SyntaxKind.ArrayLiteralExpression) {
      for (const el of node.elements) flows.push({ expr: el, site: 'element' });
      return;
    }
    const flow = flowOf(node);
    if (flow) flows.push(flow);
  }

  statementOf(node) {
    let at = node;
    while (at.parent && at.parent.kind !== SyntaxKind.SourceFile) at = at.parent;
    return at.parent ? at : undefined;
  }

  reach() {
    const live = new Set();
    const work = [];
    const mark = (statement) => {
      if (!statement) return;
      const key = keyOf(statement);
      if (live.has(key)) return;
      live.add(key);
      work.push(statement);
    };
    for (const file of this.entries) {
      for (const statement of this.sources.get(file).statements) mark(statement);
    }
    for (const sf of this.sources.values()) {
      for (const statement of sf.statements) {
        if (statement.kind === SyntaxKind.ExpressionStatement) mark(statement);
      }
    }
    const paths = new Set([...this.sources.values()].map((sf) => sf.path));
    const seen = new Set();
    while (work.length > 0) {
      const ids = identifiers(work.splice(0, work.length));
      for (const decl of this.declarationsOf(ids)) {
        const key = handleKey(decl);
        if (!paths.has(decl.path) || seen.has(key)) continue;
        seen.add(key);
        const node = decl.resolve();
        if (node) mark(this.statementOf(node));
      }
    }
    this.live = live;
  }

  declarationsOf(ids) {
    const out = [];
    const BATCH = 4000;
    for (let i = 0; i < ids.length; i += BATCH) {
      for (let symbol of this.checker.getSymbolAtLocation(ids.slice(i, i + BATCH))) {
        if (!symbol) continue;
        if (symbol.flags & SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
        out.push(...(symbol.declarations ?? []));
      }
    }
    return out;
  }

  isLive(node) {
    const statement = this.statementOf(node);
    return statement ? this.live.has(keyOf(statement)) : true;
  }

  declKeyOf(handle) {
    const key = handleKey(handle);
    if (!this.declNames.has(key) && isLibPath(handle.path)) {
      const node = handle.resolve();
      this.libDecls.set(key, node ? qualifiedName(node) : '?');
    }
    this.declNames.set(key, handle);
    return key;
  }

  libName(key) {
    return this.libDecls.get(key);
  }

  resolveCalls() {
    for (const call of this.calls) {
      const decl = this.checker.getResolvedSignature(call.node)?.declaration;
      if (!decl) {
        call.unresolved = true;
        continue;
      }
      const key = this.declKeyOf(decl);
      call.decl = decl;
      call.callees.add(key);
      call.lib = this.libName(key);
      if (call.lib !== undefined) this.functionMethod(call);
    }
  }

  functionMethod(call) {
    const method = /^(CallableFunction|Function|NewableFunction)\.(call|apply|bind)$/.exec(
      call.lib
    );
    const receiver = method && call.node.expression.expression;
    if (!receiver) return;
    const own = this.signatureKeys(this.typeAt(receiver));
    if (method[2] !== 'bind') {
      for (const k of own) call.callees.add(k);
      return;
    }
    const bound = this.signatureKeys(this.typeAt(call.node));
    for (const k of own)
      for (const b of bound) this.edge(k, b, { site: 'bind', source: call.node });
  }

  typeAt(node) {
    return this.checker.getTypeAtLocation(node);
  }

  signatures(type) {
    if (!type) return [];
    const cached = this.sigCache.get(type.id);
    if (cached) return cached;
    const out = [];
    this.sigCache.set(type.id, out);
    if (type.flags & TypeFlags.Union || type.flags & TypeFlags.Intersection) {
      for (const part of type.getTypes() ?? []) out.push(...this.signatures(part));
    }
    for (const sig of this.checker.getSignaturesOfType(type, SignatureKind.Call)) out.push(sig);
    return out;
  }

  signatureKeys(type) {
    const keys = [];
    for (const sig of this.signatures(type)) {
      if (sig.declaration) keys.push(this.declKeyOf(sig.declaration));
    }
    return keys;
  }

  edge(from, to, site) {
    if (from === to) return;
    let set = this.edges.get(from);
    if (!set) this.edges.set(from, (set = new Map()));
    if (!set.has(to)) set.set(to, site);
  }

  sourcesOf(expr) {
    const out = [];
    const walk = (e) => {
      if (!e) return;
      if (UNWRAPPED.has(e.kind)) return walk(e.expression);
      if (e.kind === SyntaxKind.ConditionalExpression) {
        walk(e.whenTrue);
        walk(e.whenFalse);
        return;
      }
      if (e.kind === SyntaxKind.BinaryExpression && LOGICAL.has(e.operatorToken.kind)) {
        walk(e.left);
        walk(e.right);
        return;
      }
      if (
        e.kind === SyntaxKind.BinaryExpression &&
        e.operatorToken.kind === SyntaxKind.CommaToken
      ) {
        walk(e.right);
        return;
      }
      out.push(e);
    };
    walk(expr);
    return out;
  }

  interesting(expr) {
    switch (expr.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.TemplateExpression:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression:
      case SyntaxKind.TypeOfExpression:
      case SyntaxKind.VoidExpression:
      case SyntaxKind.DeleteExpression:
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.RegularExpressionLiteral:
        return false;
      case SyntaxKind.BinaryExpression:
        return false;
      default:
        return true;
    }
  }

  resolveFlows() {
    const candidates = [];
    for (const flow of this.pendingFlows ?? []) {
      for (const source of this.sourcesOf(flow.expr)) {
        if (this.interesting(source)) candidates.push({ ...flow, source });
      }
    }
    this.pendingFlows = undefined;
    const BATCH = 2000;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH);
      const types = this.checker.getTypeAtLocation(slice.map((c) => c.source));
      slice.forEach((c, j) => {
        c.type = types[j];
      });
    }
    for (const c of candidates) {
      const type = c.type;
      if (!type || type.flags & PRIMITIVE) continue;
      const target = this.targetOf(c);
      if (c.site === 'argument') this.linkConstraint(type, c);
      if (!target || target.id === type.id) continue;
      this.link(type, target, c, 0);
    }
  }

  linkConstraint(type, c) {
    const decl = c.call.decl;
    if (!decl || isLibPath(decl.path)) return;
    const node = decl.resolve();
    const sig = node && this.checker.getSignatureFromDeclaration(node);
    if (!sig) return;
    const param = this.checker.getParameterType(sig, c.index);
    if (!param || !(param.flags & TypeFlags.TypeParameter)) return;
    const constraint = this.checker.getConstraintOfTypeParameter(param);
    if (constraint) this.link(type, constraint, c, 0);
  }

  targetOf(c) {
    if (c.site === 'cast') return this.typeAt(c.target);
    if (c.site === 'shorthand' || c.site === 'method') {
      const literal = c.member.parent;
      const context = this.checker.getContextualType(literal);
      if (!context) return undefined;
      const prop = this.checker.getPropertyOfType(context, c.member.name.text);
      return prop ? this.checker.getTypeOfSymbol(prop) : undefined;
    }
    return this.checker.getContextualType(c.source);
  }

  link(source, target, c, depth) {
    const pair = `${source.id}>${target.id}`;
    if (this.memberwise.has(pair)) return;
    this.memberwise.add(pair);
    const from = this.signatureKeys(source);
    const to = this.signatureKeys(target);
    if (from.length > 0 && to.length === 0 && depth === 0 && c.site !== 'cast') {
      this.lost.push({ from, flow: c, target });
    }
    if (c.site === 'cast' && depth === 0 && from.length === 0 && this.importValue(source)) {
      for (const t of to)
        this.opaque.push([t, { seed: `a call through a wasm import value at ${where(c.source)}` }]);
    }
    for (const f of from) for (const t of to) this.linkSignature(f, t, c);
    if (depth < 2 && from.length === 0 && to.length === 0)
      this.linkMembers(source, target, c, depth);
  }

  linkSignature(from, to, c) {
    this.edge(from, to, c);
    if (this.libName(to) !== undefined && c.site === 'argument') {
      this.libCallbacks.push({ from, to, flow: c });
    }
  }

  linkMembers(source, target, c, depth) {
    const objects = TypeFlags.Object | TypeFlags.Intersection | TypeFlags.Union;
    if (!(source.flags & objects) || !(target.flags & objects) || this.isLibType(target)) return;
    for (const prop of this.checker.getPropertiesOfType(target)) {
      const decl = prop.valueDeclaration;
      if (decl && isLibPath(decl.path)) continue;
      const own = this.checker.getPropertyOfType(source, prop.name);
      if (!own) continue;
      const s = this.checker.getTypeOfSymbol(own);
      const t = this.checker.getTypeOfSymbol(prop);
      if (!s || !t || s.id === t.id || s.flags & PRIMITIVE) continue;
      this.link(s, t, c, depth + 1);
    }
  }

  importValue(type) {
    const parts = type.flags & TypeFlags.Union ? (type.getTypes() ?? []) : [type];
    return (
      parts.some((part) => {
        const name = this.isLibType(part) ? this.libTypeName(part) : undefined;
        return name === 'Function' || (name !== undefined && this.seeds.lostInto.has(name));
      }) ||
      (this.isLibType(type) && this.seeds.lostInto.has(this.libTypeName(type)))
    );
  }

  libTypeName(type) {
    const symbol = type.getSymbol?.() ?? type.getAliasSymbol?.();
    const decl = symbol?.declarations?.[0];
    const node = decl?.resolve();
    return node ? qualifiedName(node) : undefined;
  }

  isLibType(type) {
    const symbol = type.getSymbol?.() ?? type.getAliasSymbol?.();
    const decl = symbol?.declarations?.[0];
    return decl ? isLibPath(decl.path) : false;
  }

  memberKeys(type) {
    const keys = [];
    for (const prop of this.checker.getPropertiesOfType(type)) {
      const t = this.checker.getTypeOfSymbol(prop);
      if (!t) continue;
      keys.push(...this.signatureKeys(this.checker.getNonNullableType(t) ?? t));
    }
    return keys;
  }

  within(node, outer) {
    for (let at = node; at; at = at.parent) if (at === outer) return true;
    return false;
  }

  forwardingSites() {
    for (const f of this.seeds.forwarders) {
      const node = f.find(this.sources.get(f.file) ?? this.sourceFile(f.file));
      if (!node) throw new Error(`derive-async: forwarder not found in ${f.file}`);
      f.key = keyOf(node);
    }
    const sites = [];
    for (const call of this.calls) {
      const args = call.node.arguments ?? [];
      if (call.lib === 'ProxyConstructor' && args.length === 2) {
        sites.push({ scope: args[1], target: args[0] });
      }
      for (const f of this.seeds.forwarders) {
        if (call.callees.has(f.key) && args[f.argument]) {
          sites.push({ scope: this.functions.get(f.key)?.node, target: args[f.argument] });
        }
      }
    }
    return sites;
  }

  forwarded() {
    const sites = this.forwardingSites();
    const kept = [];
    for (const lost of this.lost) {
      const inside = sites.filter((site) => this.within(lost.flow.source, site.scope));
      if (inside.length === 0) kept.push(lost);
      for (const site of inside) {
        const members = this.memberKeys(this.typeAt(site.target));
        for (const from of lost.from) for (const to of members) this.edge(from, to, lost.flow);
      }
    }
    this.lost = kept;
  }

  propagate() {
    const tainted = new Map();
    const work = [];
    const taint = (key, why) => {
      if (tainted.has(key)) return;
      tainted.set(key, why);
      work.push(key);
    };
    for (const [key, why] of this.seedKeys()) taint(key, why);
    const callers = new Map();
    for (const call of this.calls) {
      for (const k of call.callees) {
        let list = callers.get(k);
        if (!list) callers.set(k, (list = []));
        list.push(call);
      }
    }
    while (work.length > 0) {
      const key = work.pop();
      for (const call of callers.get(key) ?? []) {
        if (call.tainted) continue;
        call.tainted = key;
        const fn = call.fn;
        if (fn && !fn.field && !fn.async && !fn.tainted) {
          fn.tainted = call;
          taint(fn.key, { call: call.node });
        }
      }
      for (const [to, site] of this.edges.get(key) ?? []) taint(to, { from: key, site });
    }
    this.tainted = tainted;
  }

  seedKeys() {
    const out = [];
    for (const call of this.calls) {
      for (const k of call.callees) {
        const lib = this.libName(k);
        if (lib !== undefined && this.seeds.lib.has(lib)) out.push([k, { seed: lib }]);
      }
    }
    out.push(...this.opaque);
    for (const { file, find } of this.seeds.source) {
      const sf = this.sources.get(file) ?? this.sourceFile(file);
      const node = find(sf);
      if (!node) throw new Error(`derive-async: seed not found in ${file}`);
      out.push([keyOf(node), { seed: `${file}` }]);
    }
    return out;
  }

  report() {
    const errors = [
      ...this.functionProblems(),
      ...this.callProblems(),
      ...this.callbackProblems(),
      ...this.lostProblems(),
    ];
    const warnings = this.calls
      .filter((call) => call.unresolved && call.fn && !call.fn.field)
      .map((call) => this.problem(call.node, 'a call with no resolvable signature'));
    const unique = (list) => [
      ...new Map(list.filter((p) => this.isLive(p.node)).map((p) => [p.text, p])).values(),
    ];
    return { errors: unique(errors), warnings: unique(warnings) };
  }

  functionProblems() {
    const errors = [];
    for (const fn of this.functions.values()) {
      if (!fn.tainted) continue;
      const reason = SYNC_ONLY.get(fn.kind) ?? (fn.generator ? 'a generator' : undefined);
      if (reason) errors.push(this.problem(fn.tainted.node, `a blocking call in ${reason}`));
      const defaults = fn.calls.filter((c) => c.tainted && this.inParameter(c.node, fn.node));
      for (const call of defaults) {
        errors.push(this.problem(call.node, 'a blocking call in a parameter default'));
      }
    }
    return errors;
  }

  callProblems() {
    const errors = [];
    const fields = this.fields.flatMap((field) => field.calls).filter((c) => c.tainted);
    for (const call of fields) {
      errors.push(this.problem(call.node, 'a blocking call in a class field initializer'));
    }
    for (const call of this.topLevel.filter((c) => c.tainted)) {
      errors.push(this.problem(call.node, 'a blocking call at module top level'));
    }
    for (const call of this.calls.filter((c) => c.tainted)) {
      if (call.node.kind === SyntaxKind.NewExpression) {
        errors.push(this.problem(call.node, 'a blocking constructor'));
      } else if (this.optionalTail(call.node)) {
        errors.push(
          this.problem(
            call.node,
            'a blocking call inside an optional chain that continues after it'
          )
        );
      }
    }
    return errors;
  }

  callbackProblems() {
    const errors = [];
    for (const cb of this.libCallbacks) {
      if (!this.tainted.has(cb.from)) continue;
      const lib = cb.flow.call?.lib ?? this.libName(cb.to);
      if (this.seeds.asyncCallbacks.has(lib)) continue;
      const reason = `a blocking function passed as a callback to ${lib}, which calls it synchronously`;
      errors.push(this.problem(cb.flow.source, reason));
    }
    return errors;
  }

  lostProblems() {
    const errors = [];
    for (const lost of this.lost) {
      if (!lost.from.some((k) => this.tainted.has(k) && this.functions.has(k))) continue;
      const lib = this.isLibType(lost.target) && this.libTypeName(lost.target);
      if (lib && this.seeds.lostInto.has(lib)) continue;
      const shown = this.checker.typeToString(lost.target);
      const reason = `a blocking function flows into a value of type ${shown}, where its calls cannot be followed`;
      errors.push(this.problem(lost.flow.source, reason));
    }
    return errors;
  }

  optionalTail(node) {
    const parent = node.parent;
    const chained =
      (parent.kind === SyntaxKind.PropertyAccessExpression ||
        parent.kind === SyntaxKind.ElementAccessExpression ||
        parent.kind === SyntaxKind.CallExpression) &&
      parent.expression === node;
    return chained && (parent.flags & 32) !== 0 && parent.questionDotToken === undefined;
  }

  inParameter(node, fn) {
    for (let at = node; at && at !== fn; at = at.parent) {
      if (at.kind === SyntaxKind.Parameter) return true;
    }
    return false;
  }

  problem(node, reason) {
    const at = lineOf(node);
    const text = `${at.file}:${at.line}:${at.column}: ${reason}`;
    return { ...at, node, reason, text, snippet: node.getText().split('\n')[0].slice(0, 100) };
  }

  explain(key, depth = 12) {
    const lines = [];
    let at = key;
    for (let i = 0; i < depth && at; i++) {
      const why = this.tainted.get(at);
      const node = this.functions.get(at)?.node ?? this.declNames.get(at)?.resolve?.();
      lines.push(
        `${node ? where(node) : at} ${node ? node.getText().split('\n')[0].slice(0, 80) : ''}`
      );
      if (!why || why.seed) {
        if (why?.seed) lines.push(`seed ${why.seed}`);
        break;
      }
      if (why.call) {
        const call = this.calls.find((c) => c.node === why.call);
        lines.push(`  calls ${where(why.call)} ${why.call.getText().split('\n')[0].slice(0, 80)}`);
        at = call?.tainted;
      } else {
        lines.push(`  flows from (${why.site.site}) ${where(why.site.source)}`);
        at = why.from;
      }
    }
    return lines.join('\n');
  }
}

export { keyOf, where };
