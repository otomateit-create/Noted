/**
 * Les prompts livres avec l'application sont des fichiers Markdown, inlines
 * dans le bundle a la construction par le `?raw` de Vite. Sans cette
 * declaration, TypeScript ne connait pas la forme de ces imports.
 */
declare module '*.md?raw' {
  const content: string
  export default content
}
