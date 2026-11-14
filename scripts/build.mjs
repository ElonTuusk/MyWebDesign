import { mkdir, rm, readdir, copyFile, cp, writeFile } from 'node:fs/promises';
import { renderProductPage, productPages } from './render-products.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
// Explicit public files only: secrets, server functions, tests and dependencies never enter the web root.
for (const file of await readdir('.')) {
  if (/\.(html|jpe?g|png|webp|ico|svg)$/i.test(file)) await copyFile(file, `dist/${file}`);
}
await cp('assets', 'dist/assets', { recursive: true });
for (const page of productPages) await writeFile(`dist/${page.path}`, renderProductPage(page));
console.log('Built static site in dist/. Server functions are bundled separately by Netlify.');
