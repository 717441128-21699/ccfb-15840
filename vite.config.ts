import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 长信号补零 FFT(可达 26 万点)内存峰值高,单进程避免 worker OOM
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
