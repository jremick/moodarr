import ts from 'typescript';
import { build } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true,
  outDir: `${root}/dist/server-types`,
};
const sourceFile = `${root}/server/poster-enrichment.ts`;
const program = ts.createProgram([sourceFile], config);
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n',
}));
program.emit();
await build({ configFile: false, build: { outDir: `${root}/dist`, emptyOutDir: false,
  lib: { entry: sourceFile, formats: ['es'], fileName: () => 'poster-enrichment.mjs' },
  target: 'es2022', minify: false, sourcemap: false } });
await writeFile(`${root}/dist/poster-enrichment.d.mts`, "export * from './server-types/poster-enrichment.js';\n");
