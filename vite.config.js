import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  publicDir: 'public',
  server: { watch: { ignored: ['**/*.tmpdir/**', '**/.git/**', '**/dist/**'] } },
  worker: { format: 'es' },
});
