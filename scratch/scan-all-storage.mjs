import fs from 'node:fs';
import path from 'node:path';

function findFiles(dir, ext = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.html']) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name)) {
        results = results.concat(findFiles(full, ext));
      }
    } else if (ext.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

const files = findFiles('src');
const storageUsages = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (line.includes('localStorage')) {
      storageUsages.push({ type: 'localStorage', file, lineNum, line: line.trim() });
    }
    if (line.includes('sessionStorage')) {
      storageUsages.push({ type: 'sessionStorage', file, lineNum, line: line.trim() });
    }
    if (line.includes('indexedDB') || line.includes('IndexedDB')) {
      storageUsages.push({ type: 'IndexedDB', file, lineNum, line: line.trim() });
    }
  });
}

console.log(`Found ${storageUsages.length} storage usages.`);
const byType = {};
for (const u of storageUsages) {
  byType[u.type] = (byType[u.type] || 0) + 1;
}
console.log('Breakdown by type:', byType);

const byFile = {};
for (const u of storageUsages) {
  const rel = path.relative('.', u.file);
  byFile[rel] = (byFile[rel] || 0) + 1;
}
console.log('\nUsages by file:');
for (const [f, count] of Object.entries(byFile).sort((a,b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(3, ' ')} : ${f}`);
}
