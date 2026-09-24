import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    // e2e/ belongs to Playwright — vitest's default include would otherwise
    // pick up *.spec.ts files it cannot run.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
