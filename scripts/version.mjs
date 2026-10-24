import { readFileSync, writeFileSync } from 'node:fs';
const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
writeFileSync(new URL('../src/version.ts', import.meta.url), `// Generated from package.json by scripts/version.mjs.\nexport const library = ${JSON.stringify({ name, version })} as const;\n`);
