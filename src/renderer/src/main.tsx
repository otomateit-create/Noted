import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Feuille de KaTeX : elle apporte ses polices mathematiques, sans lesquelles
// les integrales et les fractions se rendraient avec la police du texte.
import 'katex/dist/katex.min.css'
import './styles/global.css'
import './styles/tailwind.css'

const container = document.getElementById('root')
if (!container) throw new Error('Élément racine introuvable')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
