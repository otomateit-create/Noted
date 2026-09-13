import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { construireVoix } from './scripts/construire-voix.mjs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

/**
 * Le calcul des vecteurs de sens tourne dans un vrai processus Node, lance par
 * le processus principal, pour une raison verifiee — sous Electron, l'inference
 * ONNX ne rend jamais la main. Son script doit donc rester un fichier a part
 * sur le disque, a cote du bundle, et non etre inline dedans.
 */
function copyWorkers(): Plugin {
  return {
    name: 'noted-copy-workers',
    closeBundle() {
      mkdirSync(resolve('out/main'), { recursive: true })
      for (const from of ['src/main/rag/embed-worker.cjs', 'src/main/voix/kokoro-worker.cjs']) {
        copyFileSync(resolve(from), resolve('out/main', from.split('/').pop() as string))
      }
      // L'oreille du mode voix, et le lecteur qui joue ce que le modele de
      // voix fabrique : un binaire natif, compile par swiftc a cote du bundle.
      construireVoix()
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
