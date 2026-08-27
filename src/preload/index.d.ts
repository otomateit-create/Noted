import type { NotedApi } from '../shared/types'

declare global {
  interface Window {
    noted: NotedApi
  }
}

export {}
