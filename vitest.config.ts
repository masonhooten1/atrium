import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the tsconfig "@" path alias — tests import app modules that use it.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // e2e/ belongs to Playwright — vitest's default include would otherwise
    // pick up *.spec.ts files it cannot run.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
