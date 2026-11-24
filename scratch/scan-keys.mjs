import fs from 'node:fs';
import path from 'node:path';

function findFiles(dir, ext = ['.js', '.jsx']) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
        results = results.concat(findFiles(full, ext));
      }
    } else if (ext.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

const files = findFiles('src');
const keys = new Set();
const keyOccurrences = {};

const regexes = [
  /localStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*['"`]([a-zA-Z0-9_\-]+)['"`]/g,
  /readLS\s*\(\s*['"`]([a-zA-Z0-9_\-]+)['"`]/g,
  /writeLS\s*\(\s*['"`]([a-zA-Z0-9_\-]+)['"`]/g,
  /readJson\s*\(\s*['"`]([a-zA-Z0-9_\-]+)['"`]/g,
  /writeJson\s*\(\s*['"`]([a-zA-Z0-9_\-]+)['"`]/g,
];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const re of regexes) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const k = m[1];
      keys.add(k);
      if (!keyOccurrences[k]) keyOccurrences[k] = new Set();
      keyOccurrences[k].add(path.relative('src', file));
    }
  }
}

console.log(`Found ${keys.size} direct storage keys:`);
for (const k of Array.from(keys).sort()) {
  console.log(`  ${k} (used in: ${Array.from(keyOccurrences[k]).slice(0, 3).join(', ')}${keyOccurrences[k].size > 3 ? '...' : ''})`);
}
