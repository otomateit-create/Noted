import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

/**
 * Deux calculs tournent dans de vrais processus Node, lances par le processus
 * principal : les vecteurs de sens et la detection de mise en page. Tous deux
 * pour la meme raison, verifiee — sous Electron, l'inference ONNX ne rend
 * jamais la main. Leurs scripts doivent donc rester des fichiers a part sur le
 * disque, a cote du bundle, et non etre inlines dedans.
 */
function copyWorkers(): Plugin {
  return {
    name: 'noted-copy-workers',
    closeBundle() {
      mkdirSync(resolve('out/main'), { recursive: true })
      for (const from of ['src/main/rag/embed-worker.cjs', 'src/main/ocr/layout-worker.cjs']) {
        copyFileSync(resolve(from), resolve('out/main', from.split('/').pop() as string))
      }
    }
  }
}

export default defineConfig({
  main: {
    // Le SDK Claude lance le binaire claude en sous-processus : il doit rester
    // un vrai module sur disque, pas du code inline dans le bundle.
    plugins: [externalizeDepsPlugin(), copyWorkers()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: {
          // Le SDK Claude est ESM-only. Sans ceci, Rollup traduirait notre
          // import() dynamique en require() dans la sortie CJS, et le
          // chargement echouerait au premier message envoye.
          dynamicImportInCjs: true
        }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },

  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
