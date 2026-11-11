import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

const localApi = {
  name: 'linkmural-local-api',
  configureServer(server: { middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return next()
      const path = new URL(req.url || '/', 'http://localhost').pathname
      const handlerPath = path === '/api/profiles' ? './api/profiles' : path === '/api/token' ? './api/token' : null
      if (!handlerPath) return next()

      void (async () => {
        const url = new URL(req.url || '/', 'http://localhost')
        const bodyChunks: Uint8Array[] = []
        let size = 0
        if (req.method === 'POST') {
          for await (const chunk of req) {
            const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk as Uint8Array
            size += bytes.byteLength
            if (size > 16_384) {
              res.statusCode = 413
              res.end(JSON.stringify({ error: 'Dados enviados excedem o limite.' }))
              return
            }
            bodyChunks.push(bytes)
          }
        }
        let body: unknown
        if (bodyChunks.length) {
          try { body = JSON.parse(new TextDecoder().decode(Buffer.concat(bodyChunks))) }
          catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Corpo JSON inválido.' }))
            return
          }
        }
        Object.assign(req, { query: Object.fromEntries(url.searchParams.entries()), body })
        const response = {
          statusCode: 200,
          status(code: number) { this.statusCode = code; return this },
          json(payload: unknown) {
            res.statusCode = this.statusCode
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(payload))
            return this
          },
        }
        const { default: handler } = await server.ssrLoadModule(handlerPath)
        await handler(req, response)
      })().catch(error => {
        console.error('Local API error:', error instanceof Error ? error.message : 'unknown')
        if (!res.headersSent) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Erro interno.' }))
        }
      })
    })
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ABLY_API_KEY']) {
    if (env[key]) process.env[key] = env[key]
  }
  return { plugins: [react(), ...(mode === 'development' ? [localApi] : [])] }
})
