/**
 * Docker Hub Registry 代理 Worker — dev-sidecar-standalone 模板
 *
 * 部署教程见 docs/worker-deploy.md, 配置完成后:
 *   dss docker mirror add https://<你的域名>[/<ACCESS_TOKEN>]
 *
 * 可选环境变量(Worker Settings → Variables):
 *   ACCESS_TOKEN    访问令牌。设置后所有请求必须携带路径前缀
 *                  https://<域名>/<token>/v2/..., 错误/缺失返回 404
 *                  (404 伪装普通站点, 不暴露代理存在)。留空 = 不鉴权
 *   DOCKERHUB_AUTH  你的 Docker Hub 凭证 "username:personal-access-token"。
 *                  填写后 Worker 用它向上游换取 Bearer token,
 *                  避开匿名拉取限额(所有用户共享 CF 出口 IP, 匿名容易撞限额)
 *   R2_CACHE        R2 存储绑定名(需在 Worker 设置里绑定 R2 bucket 并填绑定名,
 *                  如 "CACHE")。设置后 layer 缓存进 R2, 二次拉取不再回源
 *
 * 工作原理:
 *   客户端(dockerd) → 本 Worker → registry-1.docker.io(经 Worker 侧认证)
 *   认证流程由 Worker 代办(auth.docker.io 仅 Worker 访问, 客户端不接触),
 *   layer 307 重定向由 Worker 跟进并流式转发(客户端无法直连 CDN)。
 */

const UPSTREAM_REGISTRY = 'https://registry-1.docker.io'
const UPSTREAM_AUTH = 'https://auth.docker.io/token'
const UA = 'dev-sidecar-worker/1.0'

// Worker isolate 级别的 token 缓存(免每个请求都回源换 token)
let cachedToken = null
let cachedTokenExpire = 0

export default {
  async fetch (request, env, ctx) {
    _ctx = ctx
    try {
      const url = new URL(request.url)
      let path = url.pathname

      // ---- 可选鉴权: 路径前缀模式 ----
      if (env.ACCESS_TOKEN) {
        const prefix = `/${env.ACCESS_TOKEN}`
        if (path !== prefix && !path.startsWith(`${prefix}/`)) {
          return new Response('Not Found', { status: 404 })
        }
        path = path.slice(prefix.length) || '/'
      }

      if (!path.startsWith('/v2/')) {
        // 根路径返回 404, 不暴露服务信息
        return new Response('Not Found', { status: 404 })
      }

      // /v2/ 探活: 客户端与 dss docker mirror add 的健康检查都依赖它
      if (path === '/v2/' || path === '/v2') {
        return new Response('{}', {
          status: 200,
          headers: { 'Docker-Distribution-API-Version': 'registry/2.0' },
        })
      }

      // /v2/<name>/blobs/<digest> → 可能 307 到 CDN, 必须由 Worker 跟进
      if (/^\/v2\/.+\/blobs\//.test(path)) {
        return proxyBlob(request, env, path)
      }

      // manifests / tags / 其他 registry API → 直接代理(manifest 走 Cache API)
      return proxyManifest(request, env, path)
    } catch (e) {
      return new Response(`proxy error: ${e.message}`, { status: 502 })
    }
  },
}

/** 获取上游 Bearer token(匿名或 DOCKERHUB_AUTH), 带缓存 */
async function getUpstreamToken (env, scope) {
  const now = Date.now() / 1000
  if (cachedToken && now < cachedTokenExpire - 60) return cachedToken

  const authUrl = new URL(UPSTREAM_AUTH)
  authUrl.searchParams.set('service', 'registry.docker.io')
  if (scope) authUrl.searchParams.set('scope', scope)

  const headers = { 'User-Agent': UA }
  if (env.DOCKERHUB_AUTH) {
    headers.Authorization = `Basic ${btoa(env.DOCKERHUB_AUTH)}`
  }

  const r = await fetch(authUrl.toString(), { headers })
  if (!r.ok) throw new Error(`auth.docker.io ${r.status}`)
  const data = await r.json()
  cachedToken = data.token
  cachedTokenExpire = now + (data.expires_in || 300)
  return cachedToken
}

/** 从 /v2/<name>/manifests/... 路径提取 repository scope */
function extractScope (path) {
  const m = path.match(/^\/v2\/(.+)\/(manifests|blobs|tags)\//)
  return m ? `repository:${m[1]}:pull` : 'registry:catalog:*'
}

async function proxyManifest (request, env, path) {
  const cache = caches.default
  const cacheKey = new Request(`https://inner${path}`, request)
  // manifest 不可变(ref+digest 唯一), 命中直接返回
  if (request.method === 'GET' && path.includes('/manifests/')) {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  }

  const token = await getUpstreamToken(env, extractScope(path))
  const upstream = await fetch(`${UPSTREAM_REGISTRY}${path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
      Accept: request.headers.get('Accept') || 'application/vnd.docker.distribution.manifest.v2+json',
    },
  })

  const resp = new Response(upstream.body, upstream)
  resp.headers.set('Docker-Distribution-API-Version', 'registry/2.0')
  if (request.method === 'GET' && path.includes('/manifests/') && upstream.status === 200) {
    ctxWaitUntil(cache.put(cacheKey, resp.clone()))
  }
  return resp
}

async function proxyBlob (request, env, path) {
  // R2 缓存(可选): 命中则零回源
  if (env.R2_CACHE) {
    const key = path // /v2/<name>/blobs/<digest> 天然唯一
    const hit = await env.R2_CACHE.get(key.slice(1))
    if (hit) {
      return new Response(hit.body, {
        headers: {
          'Content-Length': hit.size,
          'Content-Type': 'application/octet-stream',
          'Docker-Distribution-Blob-Digest': digestFromPath(path),
        },
      })
    }
  }

  const token = await getUpstreamToken(env, extractScope(path))
  // redirect: 'manual' — 拿到 307 的 CDN 地址后由 Worker 亲自拉取并流式回传,
  // 客户端永远不直连 production.cloudflare.docker.com(墙内不可达)
  let upstream = await fetch(`${UPSTREAM_REGISTRY}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
    redirect: 'manual',
  })

  if (upstream.status >= 300 && upstream.status < 400) {
    const cdnUrl = upstream.headers.get('Location')
    if (cdnUrl) {
      upstream = await fetch(cdnUrl, { redirect: 'follow' })
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(upstream.body, { status: upstream.status })
  }

  const headers = {
    'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
    'Docker-Distribution-Blob-Digest': digestFromPath(path),
  }
  const len = upstream.headers.get('Content-Length')
  if (len) headers['Content-Length'] = len

  // R2 写入(可选): 流式回传的同时异步落缓存
  if (env.R2_CACHE && upstream.status === 200 && upstream.body) {
    const [a, b] = upstream.body.tee()
    ctxWaitUntil(env.R2_CACHE.put(key.slice(1), a))
    return new Response(b, { headers })
  }
  return new Response(upstream.body, { headers })
}

function digestFromPath (path) {
  const m = path.match(/blobs\/(sha256:[a-f0-9]+)$/)
  return m ? m[1] : ''
}

// waitUntil 需要事件上下文, 在 fetch 入口注入
let _ctx = null
function ctxWaitUntil (p) {
  if (_ctx) _ctx.waitUntil(p)
}
