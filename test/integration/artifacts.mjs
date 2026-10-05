import { locate } from './server.mjs';

export const artifacts = new URL('../../artifacts/', import.meta.url);
export const raw = new URL('../../node_modules/.cache/slicc-kernel-coverage/', import.meta.url);

export function source(url) {
  return locate(new URL(url).pathname);
}

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
