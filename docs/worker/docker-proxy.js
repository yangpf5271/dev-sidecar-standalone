/**
 * Docker Hub Registry 代理 Worker — dev-sidecar-standalone 模板
 *
 * 部署教程见 docs/worker-deploy.md, 配置完成后:
 *   dss docker mirror add https://<你的域名>          (Basic 模式, 全 Docker 版本)
 *   dss docker mirror add https://<你的域名>/<token>  (路径模式, 需 Docker ≥ 24)
 *
 * 可选环境变量(Worker Settings → Variables):
 *   ACCESS_TOKEN    访问令牌(自定义随机串)。留空 = 不鉴权。设置后支持两种认证:
 *                  A. Basic 模式(推荐, 全版本): 客户端执行一次
 *                     docker login <域名> -u any -p <token>
 *                  B. 路径模式(需 Docker Engine ≥ 24, 旧版 daemon 会因
 *                     mirror URL 含路径而拒绝启动): 地址带 /<token> 前缀
 *                  两者均不满足: /v2/ 返回 401 Basic 质询, 其余返回 404 伪装
 *   DOCKERHUB_AUTH  你的 Docker Hub 凭证 "username:personal-access-token"(仅 ASCII)。
 *                  填写后 Worker 用它向上游按仓库换取 Bearer token,
 *                  避开匿名拉取限额(所有用户共享 CF 出口 IP, 匿名容易撞限额)
 *   R2_CACHE        R2 layer 缓存。两种配置等价:
 *                  a. R2 bucket 绑定名直接叫 R2_CACHE(推荐)
 *                  b. 绑定名任意(如 CACHE), 变量 R2_CACHE 填该绑定名
 *                  超过 512MB 的 layer 不缓存;断连时缓存写入最多延续 ~30s
 *
 * 工作原理(与社区成熟方案一致, 经 moby 源码验证):
 *   /v2/ 返回 200(无 WWW-Authenticate)→ dockerd 注册空 challenge 集合,
 *   不构建 auth handler、绝不自行联系 auth.docker.io;
 *   认证由 Worker 服务端代办(按仓库 scope 换 token 并缓存);
 *   blob 的 307 CDN 重定向由 Worker 跟进(客户端无法直连 layer CDN),
 *   且不把 Authorization 带给 CDN(避开 S3 签名校验坑);
 *   Range 断点续传全链路透传(中国→CF 链路不稳时避免整层重下)。
 */

const UPSTREAM_REGISTRY = 'https://registry-1.docker.io'
const UPSTREAM_AUTH = 'https://auth.docker.io/token'
const UA = 'dev-sidecar-worker/1.1'
const R2_MAX_CACHE_BYTES = 512 * 1024 * 1024 // 超 512MB 的 layer 不缓存

// token 按 scope(仓库)分键缓存 — Docker Hub token 的 access 声明只含请求的仓库,
// 单槽缓存会导致拉第二个镜像 401
const tokenCache = new Map() // scope -> { token, expire }

export default {
  async fetch (request, env, ctx) {
    try {
      const url = new URL(request.url)
      let path = url.pathname
      let authorized = !env.ACCESS_TOKEN

      // ---- 可选鉴权 ----
      if (env.ACCESS_TOKEN) {
        const prefix = `/${env.ACCESS_TOKEN}`
        const authHeader = request.headers.get('Authorization') || ''
        if (path !== prefix && !path.startsWith(`${prefix}/`)) {
          // 非 token 路径: 尝试 Basic 模式(any 用户名 + token 密码)
          let ok = false
          const m = authHeader.match(/^Basic\s+(.+)$/i)
          if (m) {
            try {
              const [user, pass] = atob(m[1]).split(':')
              ok = pass === env.ACCESS_TOKEN
            } catch { ok = false }
          }
          if (!ok) {
            // /v2/ 返回 401 Basic 质询(触发客户端 docker login 流程), 其余 404 伪装
            if (path === '/v2/' || path === '/v2') {
              return new Response('{"errors":[{"code":"UNAUTHORIZED"}]}', {
                status: 401,
                headers: {
                  'WWW-Authenticate': 'Basic realm="docker proxy",service="registry-proxy"',
                  'Docker-Distribution-API-Version': 'registry/2.0',
                  'Content-Type': 'application/json',
                },
              })
            }
            return new Response('Not Found', { status: 404 })
          }
          authorized = true
        } else {
          path = path.slice(prefix.length) || '/' // 路径模式: 剥离 token 前缀
        }
      }

      if (!path.startsWith('/v2/')) {
        return new Response('Not Found', { status: 404 })
      }

      // /v2/ 探活: dockerd ping 与 dss docker mirror add 健康检查依赖它
      if (path === '/v2/' || path === '/v2') {
        return new Response('{}', {
          status: 200,
          headers: { 'Docker-Distribution-API-Version': 'registry/2.0' },
        })
      }

      if (/^\/v2\/.+\/blobs\//.test(path)) {
        return await proxyBlob(request, env, ctx, path, url.search)
      }
      return await proxyManifest(request, env, ctx, path, url.search)
    } catch (e) {
      return new Response(`proxy error: ${e.message}`, { status: 502 })
    }
  },
}

/** 获取 R2 绑定: 兼容「绑定名就叫 R2_CACHE」与「变量 R2_CACHE 填绑定名」两种配置 */
function getR2 (env) {
  const v = env.R2_CACHE
  if (typeof v === 'string') return env[v]
  return v
}

/** 获取上游 Bearer token(匿名或 DOCKERHUB_AUTH), 按 scope 缓存 */
async function getUpstreamToken (env, scope) {
  const now = Date.now() / 1000
  const hit = tokenCache.get(scope)
  if (hit && now < hit.expire - 60) return hit.token

  const authUrl = new URL(UPSTREAM_AUTH)
  authUrl.searchParams.set('service', 'registry.docker.io')
  if (scope) authUrl.searchParams.set('scope', scope)

  const headers = { 'User-Agent': UA }
  if (env.DOCKERHUB_AUTH) {
    if (/[^\x00-\xFF]/.test(env.DOCKERHUB_AUTH)) {
      throw new Error('DOCKERHUB_AUTH 仅支持 ASCII(用户名:令牌)')
    }
    headers.Authorization = `Basic ${btoa(env.DOCKERHUB_AUTH)}`
  }

  const r = await fetch(authUrl.toString(), { headers })
  if (!r.ok) throw new Error(`auth.docker.io ${r.status}`)
  const data = await r.json()
  if (tokenCache.size > 64) tokenCache.clear() // 粗暴上限, 防 isolate 长期膨胀
  tokenCache.set(scope, { token: data.token, expire: now + (data.expires_in || 300) })
  return data.token
}

/** 从 /v2/<name>/manifests/... 路径提取 repository scope */
function extractScope (path) {
  const m = path.match(/^\/v2\/(.+)\/(manifests|blobs|tags)\//)
  return m ? `repository:${m[1]}:pull` : 'registry:catalog:*'
}

/** 错误透传时剥离危险头: www-authenticate(诱导客户端连被墙的 auth.docker.io)、content-encoding */
function sanitizeErrorHeaders (resp) {
  const r = new Response(resp.body, resp)
  r.headers.delete('WWW-Authenticate')
  r.headers.delete('Content-Encoding')
  return r
}

async function proxyManifest (request, env, ctx, path, search) {
  // 只缓存 digest 引用的 manifest — 不可变且与 Accept 无关;
  // tag 引用(latest 等)会变, 缓存会导致拉到旧镜像
  const ref = path.split('/manifests/')[1] || ''
  const cacheable = request.method === 'GET' && /^sha256:[a-f0-9]{64}$/.test(ref)

  const cache = caches.default
  const cacheKey = new Request(`https://inner${path}${search}`, request)
  if (cacheable) {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  }

  const token = await getUpstreamToken(env, extractScope(path))
  const upstream = await fetch(`${UPSTREAM_REGISTRY}${path}${search}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
      Accept: request.headers.get('Accept') || 'application/vnd.docker.distribution.manifest.v2+json',
    },
  })

  if (!upstream.ok) return sanitizeErrorHeaders(upstream)

  const resp = new Response(upstream.body, upstream)
  resp.headers.delete('Content-Encoding') // Workers 已解压, 保留该头会导致客户端解码错乱
  resp.headers.set('Docker-Distribution-API-Version', 'registry/2.0')
  if (cacheable) {
    ctx.waitUntil(cache.put(cacheKey, resp.clone()))
  }
  return resp
}

/** 解析 Range 头为 {offset, length}(仅支持 bytes=a- 与 bytes=a-b) */
function parseRange (rangeHeader, fullLength) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '')
  if (!m) return null
  const offset = Number(m[1])
  const end = m[2] ? Number(m[2]) : (fullLength ? fullLength - 1 : null)
  if (Number.isNaN(offset) || offset < 0) return null
  const length = end != null ? end - offset + 1 : null
  return { offset, length, end }
}

async function proxyBlob (request, env, ctx, path, search) {
  const r2 = getR2(env)
  const key = path.slice(1) // v2/<name>/blobs/<digest> 天然唯一
  const rangeHeader = request.headers.get('Range')

  // ---- R2 命中 ----
  if (r2 && typeof r2.get === 'function') {
    if (rangeHeader) {
      const meta = await r2.head(key).catch(() => null)
      const range = meta ? parseRange(rangeHeader, meta.size) : null
      if (meta && range) {
        if (range.offset >= meta.size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } })
        }
        const length = Math.min(range.length || meta.size - range.offset, meta.size - range.offset)
        const ranged = await r2.get(key, { range: { offset: range.offset, length } }).catch(() => null)
        if (ranged) {
          const end = range.end != null ? Math.min(range.end, meta.size - 1) : meta.size - 1
          return rangeResponse(ranged.body, ranged.size, { offset: range.offset, end }, meta.size, request.method)
        }
      }
      // R2 无此对象或 Range 不合法 → 落到回源
    } else {
      const obj = await r2.get(key).catch(() => null)
      if (obj && obj.body) {
        return blobResponse(obj.body, obj.size, request.method)
      }
    }
  }

  // ---- 回源 ----
  const token = await getUpstreamToken(env, extractScope(path))
  // redirect:'manual' — 307 的 CDN 地址由 Worker 亲自拉取(不带 Authorization, 避开 S3 签名校验),
  // 客户端永远不直连 production.cloudflare.docker.com(墙内不可达)
  let upstream = await fetch(`${UPSTREAM_REGISTRY}${path}${search}`, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
      ...(rangeHeader ? { Range: rangeHeader } : {}), // 断点续传透传
    },
    redirect: 'manual',
  })

  if (upstream.status >= 300 && upstream.status < 400) {
    const cdnUrl = upstream.headers.get('Location')
    if (!cdnUrl) {
      return new Response('proxy error: redirect without location', { status: 502 })
    }
    upstream = await fetch(cdnUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: rangeHeader ? { Range: rangeHeader } : {},
      redirect: 'follow',
    })
  }

  if (!upstream.ok && upstream.status !== 206) {
    return sanitizeErrorHeaders(upstream)
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Docker-Distribution-Blob-Digest', digestFromPath(path))
  headers.set('Accept-Ranges', 'bytes')
  const len = upstream.headers.get('Content-Length')
  if (len) headers.set('Content-Length', len)
  if (upstream.status === 206) {
    const cr = upstream.headers.get('Content-Range')
    if (cr) headers.set('Content-Range', cr)
  }

  // R2 写入(可选): 仅完整 200 + 已知大小 + 低于门槛; range/206/HEAD 不写
  const size = len ? Number(len) : NaN
  if (r2 && typeof r2.put === 'function' && upstream.status === 200 &&
      Number.isFinite(size) && size > 0 && size <= R2_MAX_CACHE_BYTES && upstream.body) {
    const [a, b] = upstream.body.tee()
    ctx.waitUntil(r2.put(key, a))
    return new Response(b, { status: upstream.status, headers })
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers })
}

function blobResponse (body, size, method) {
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    },
  })
}

function rangeResponse (body, chunkSize, range, fullSize, method) {
  const end = range.end != null ? range.end : fullSize - 1
  return new Response(method === 'HEAD' ? null : body, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunkSize,
      'Content-Range': `bytes ${range.offset}-${end}/${fullSize}`,
      'Accept-Ranges': 'bytes',
    },
  })
}

function digestFromPath (path) {
  const m = path.match(/blobs\/(sha256:[a-f0-9]+)$/)
  return m ? m[1] : ''
}
