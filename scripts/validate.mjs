import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { HtmlValidate } from 'html-validate';
import assert from 'node:assert/strict';

const html = await readFile('shop.html', 'utf8');
for (const tag of ['html', 'head', 'body']) {
  assert.equal((html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g')) || []).length, 1, `one opening ${tag}`);
  assert.equal((html.match(new RegExp(`</${tag}>`, 'g')) || []).length, 1, `one closing ${tag}`);
}
assert.match(html, /<\/html>\s*$/);
const validator = new HtmlValidate({ extends: ['html-validate:recommended'], rules: { 'void-style': ['error', { style: 'omit' }] } });
const report = await validator.validateString(html, 'shop.html');
if (!report.valid) {
  for (const result of report.results) for (const message of result.messages) console.error(`${result.filePath}:${message.line}:${message.column} ${message.message} (${message.ruleId})`);
  process.exit(1);
}
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await checkDirectory(path);
    else if (/\.(mjs|js)$/.test(path)) {
      const check = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      assert.equal(check.status, 0, `${path} syntax`);
    }
  }
}
for (const directory of ['assets', 'netlify', 'scripts', 'tests']) await checkDirectory(directory);
console.log('Shop HTML structure and all checkout JavaScript syntax validated.');
