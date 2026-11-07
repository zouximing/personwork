import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['apps/server/src/index.ts'], outDir: 'apps/server/dist', format: ['esm'], target: 'node24', clean: true, sourcemap: true, noExternal: ['@workbench/contracts'] });
