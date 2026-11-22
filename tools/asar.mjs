import fs from 'node:fs';
const file = process.argv[2];
const cmd = process.argv[3];
const fd = fs.openSync(file, 'r');
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const buf = Buffer.alloc(jsonLen); fs.readSync(fd, buf, 0, jsonLen, 16);
const header = JSON.parse(buf.toString('utf8'));
const base = 8 + headerPickleSize;
function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files)) {
    const p = prefix + '/' + name;
    if (v.files) walk(v, p, out);
    // `unpacked` entries live beside the archive on disk and carry no offset;
    // offsets themselves arrive as numbers or (newer archives) decimal strings.
    else if (v.offset !== undefined) {
      const offset = Number(v.offset);
      if (Number.isFinite(offset)) out.push({ p, size: Number(v.size), offset });
    }
  }
}
const all = []; walk(header, '', all);
if (cmd === 'list') {
  const re = new RegExp(process.argv[4] || '.');
  for (const e of all) if (re.test(e.p)) console.log(e.size + '\t' + e.p);
} else if (cmd === 'cat') {
  const e = all.find((x) => x.p === process.argv[4]);
  if (!e) { console.error('NOT FOUND'); process.exit(1); }
  const out = Buffer.alloc(e.size); fs.readSync(fd, out, 0, e.size, base + e.offset);
  process.stdout.write(out);
} else if (cmd === 'grep') {
  // grep <textRegex> [pathRegex] — prints `path:line` for the first few hits per file.
  const text = new RegExp(process.argv[4] || '.');
  const paths = new RegExp(process.argv[5] || '\\.(js|mjs|ts|tsx|css|json|md)$');
  const budget = Number(process.argv[6] || 2 * 1024 * 1024);
  for (const e of all) {
    if (!paths.test(e.p) || e.size > budget) continue;
    const out = Buffer.alloc(e.size); fs.readSync(fd, out, 0, e.size, base + e.offset);
    const lines = out.toString('utf8').split('\n');
    let hits = 0;
    for (let i = 0; i < lines.length && hits < 3; i += 1) {
      if (!text.test(lines[i])) continue;
      hits += 1;
      console.log(`${e.p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
}
