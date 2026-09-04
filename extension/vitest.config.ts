import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts（那是构建配置）：只管测试与覆盖率。
// 覆盖率按 语句/分支/函数/行 四个维度出报告，排除类型声明与测试本身。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
