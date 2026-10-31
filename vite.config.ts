import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

function git(cmd: string, fallback: string): string {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

// Сведения о сборке показываются в игре, чтобы по ссылке было видно, какая версия открыта.
const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? git('rev-parse --short HEAD', 'local');
const branch = process.env.GITHUB_REF_NAME ?? git('rev-parse --abbrev-ref HEAD', 'local');

export default defineConfig({
  // Относительные пути: одна и та же сборка работает и в корне сайта, и в /preview/<ветка>/.
  base: './',
  define: {
    __BUILD_INFO__: JSON.stringify({
      commit,
      branch,
      builtAt: new Date().toISOString(),
    }),
  },
  build: {
    rollupOptions: {
      // Игра и лаборатория моделей (/lab/) — две страницы одной сборки.
      input: { main: 'index.html', lab: 'lab/index.html' },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Кэш модулей на диске не замечает новые файлы в import.meta.glob (новые модели зданий):
    // тесты видели старый список. Без кэша тесты идут меньше секунды.
    fsModuleCache: false,
  },
});
