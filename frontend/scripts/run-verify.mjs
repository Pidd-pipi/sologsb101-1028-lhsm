// 将 scripts/verify-revision.ts 与依赖打包为临时 ESM 后执行
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const result = await build({
  entryPoints: ['scripts/verify-revision.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false
});

const outFile = new URL('../node_modules/.verify-revision.mjs', import.meta.url);
writeFileSync(outFile, result.outputFiles[0].contents);
try {
  await import(pathToFileURL(outFile.pathname).href);
} finally {
  rmSync(outFile, { force: true });
}
