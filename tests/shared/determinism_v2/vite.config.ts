import { defineConfig } from 'vite'
import path from 'path'

const monoRoot = path.resolve(__dirname, '../../..')
const rootNodeModules = path.resolve(monoRoot, 'node_modules')

export default defineConfig({
  root: path.resolve(__dirname),
  resolve: {
    alias: {
      // @noble/hashes lives in the monorepo root node_modules, not engine/node_modules
      '@noble/hashes': path.resolve(rootNodeModules, '@noble/hashes'),
    },
  },
  server: {
    port: 5199,
    open: '/manual_browser.html',
    fs: {
      allow: [monoRoot],
    },
  },
})
