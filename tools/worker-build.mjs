import { isBuiltin } from 'node:module';
import { parse } from 'acorn';

const propertyName = (node, parent) =>
  parent &&
  ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
    (['Property', 'PropertyDefinition', 'MethodDefinition'].includes(parent.type) &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand));

const builtinRequire = (node, parent) =>
  parent.type === 'CallExpression' &&
  parent.callee === node &&
  parent.arguments.length === 1 &&
  parent.arguments[0].type === 'Literal' &&
  typeof parent.arguments[0].value === 'string' &&
  isBuiltin(parent.arguments[0].value);

const forbidden = new Set(['module', 'exports', '__filename', '__dirname']);

function identifier(node, parent) {
  if (node.type !== 'Identifier' || propertyName(node, parent)) return;
  if (forbidden.has(node.name)) throw new Error(`process worker references ${node.name}`);
  if (node.name === 'require' && !builtinRequire(node, parent))
    throw new Error('process worker require must load a builtin');
}

function visit(node, parent) {
  if (!node || typeof node !== 'object') return;
  identifier(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, node);
    } else if (value && typeof value === 'object') visit(value, node);
  }
}

export function assertWorkerBuild(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  if (tree.body[0]?.directive !== 'use strict') throw new Error('process worker must be strict');
  visit(tree, undefined);
}
