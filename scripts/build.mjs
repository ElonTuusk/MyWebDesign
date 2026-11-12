import { mkdir, rm, readdir, copyFile, cp } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
// Explicit public files only: secrets, server functions, tests and dependencies never enter the web root.
for (const file of await readdir('.')) {
  if (/\.(html|jpe?g|png|webp|ico|svg)$/i.test(file)) await copyFile(file, `dist/${file}`);
}
await cp('assets', 'dist/assets', { recursive: true });
console.log('Built static site in dist/. Server functions are bundled separately by Netlify.');
