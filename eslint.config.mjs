import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

const eslintConfig = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Playwright fixtures call `use(page)` to hand pages to tests — not a
    // React hook, whatever the rules-of-hooks heuristic thinks.
    files: ['e2e/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
]

export default eslintConfig
