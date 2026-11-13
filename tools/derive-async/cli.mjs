import { config } from './config.mjs';
import { analyze, closure, rel } from './index.mjs';

const root = process.cwd();
const t0 = performance.now();
const files = await closure(root, config.entries);
const { analysis, report } = analyze({ root, files, config });
const fns = [...analysis.functions.values()];
const tainted = fns.filter((f) => f.tainted);
console.log(
  `files ${files.length} functions ${fns.length} tainted ${tainted.length} calls ${analysis.calls.length} awaited ${analysis.calls.filter((c) => c.tainted).length} edges ${[...analysis.edges.values()].reduce((n, m) => n + m.size, 0)} ms ${Math.round(performance.now() - t0)}`
);
for (const e of report.errors)
  console.log(`error ${rel(root, e.file)}:${e.line}: ${e.reason} | ${e.snippet}`);
if (process.argv.includes('--warnings')) {
  for (const w of report.warnings)
    console.log(`warning ${rel(root, w.file)}:${w.line}: ${w.reason} | ${w.snippet}`);
}
const explain = process.argv.indexOf('--explain');
if (explain > 0) {
  const [file, line] = process.argv[explain + 1].split(':');
  for (const f of tainted) {
    const at = f.node.getSourceFile().getLineAndCharacterOfPosition(f.node.getStart());
    if (f.node.getSourceFile().fileName.endsWith(file) && at.line + 1 === Number(line))
      console.log(analysis.explain(f.key));
  }
}
if (process.argv.includes('--list')) {
  for (const f of tainted) {
    const sf = f.node.getSourceFile();
    const at = sf.getLineAndCharacterOfPosition(f.node.getStart());
    console.log(
      `async ${rel(root, sf.fileName)}:${at.line + 1} ${f.node.getText().split('\n')[0].slice(0, 70)}`
    );
  }
}
const members = process.argv.indexOf('--members');
if (members > 0) {
  const { SyntaxKind } = await import('typescript/unstable/ast');
  const wanted = new Set(process.argv[members + 1].split(','));
  for (const sf of analysis.sources.values()) {
    for (const st of sf.statements) {
      if (st.kind !== SyntaxKind.InterfaceDeclaration || !wanted.has(st.name.text)) continue;
      const type = analysis.checker.getTypeAtLocation(st.name);
      for (const prop of analysis.checker.getPropertiesOfType(type)) {
        const t = analysis.checker.getTypeOfSymbol(prop);
        const keys = analysis.signatureKeys(analysis.checker.getNonNullableType(t) ?? t);
        if (keys.length === 0) continue;
        console.log(
          st.name.text,
          prop.name,
          keys.some((k) => analysis.tainted.has(k)) ? 'blocking' : 'sync'
        );
      }
    }
  }
}
analysis.close();
