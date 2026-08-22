// 修改版：去掉 overwall 插件依赖（PAC/梯子），保持核心功能
const fs = require('node:fs')
const path = require('node:path')
const lodash = require('lodash')
const { LRUCache } = require('lru-cache')
const dnsUtil = require('./lib/dns')
const interceptorImpls = require('./lib/interceptor')
const log = require('./utils/util.log.server')
const matchUtil = require('./utils/util.match')

const PATH_CACHE_MAX_SIZE = 512

function buildIntercepts (intercepts) {
  return intercepts
}

function getExclusionArray (exclusions) {
  let ret = null
  if (Array.isArray(exclusions)) {
    if (exclusions.length > 0) {
      ret = exclusions
    }
  } else if (lodash.isObject(exclusions)) {
    ret = []
    for (const exclusion in exclusions) {
      ret.push(exclusion)
    }
    if (ret.length === 0) {
      return null
    }
  }
  return ret
}

function handleDnsMapping (dnsMapping, familyMapping) {
  for (const hostname in dnsMapping) {
    const value = dnsMapping[hostname]
    if (value == null) {
      delete dnsMapping[hostname]
      continue
    }
    if (typeof value === 'string') {
      dnsMapping[hostname] = {
        dnsName: value,
        family: Number.parseInt(familyMapping[hostname]) === 6 ? 6 : 4,
      }
    } else if (value.dnsName == null) {
      log.warn(`域名 ${hostname} 的DNS配置有误，未配置dnsName，配置值：`, value)
      delete dnsMapping[hostname]
    }
  }
  return dnsMapping
}

module.exports = (serverConfig) => {
  const intercepts = matchUtil.domainMapRegexply(buildIntercepts(serverConfig.intercepts))
  const whiteList = matchUtil.domainMapRegexply(serverConfig.whiteList)
  const timeoutMapping = matchUtil.domainMapRegexply(serverConfig.setting.timeoutMapping)

  const dnsMapping = handleDnsMapping(serverConfig.dns.mapping, serverConfig.dns.familyMapping || {})
  const setting = serverConfig.setting

  if (setting.verifySsl !== false) {
    setting.verifySsl = true
  }
  setting.timeoutMapping = timeoutMapping

  // 独立版不支持 overwall 插件，middlewares 始终为空
  const middlewares = []

  const preSetIpList = matchUtil.domainMapRegexply(serverConfig.preSetIpList)

  const options = {
    host: serverConfig.host,
    port: serverConfig.port,
    maxLength: serverConfig.fakeServerMaxLength || 100,
    dnsConfig: {
      preSetIpList,
      dnsMap: dnsUtil.initDNS(serverConfig.dns.providers, preSetIpList),
      mapping: matchUtil.domainMapRegexply(dnsMapping),
      speedTest: serverConfig.dns.speedTest,
    },
    setting,
    compatibleConfig: {
      connect: serverConfig.compatible ? matchUtil.domainMapRegexply(serverConfig.compatible.connect) : {},
      request: serverConfig.compatible ? matchUtil.domainMapRegexply(serverConfig.compatible.request) : {},
    },
    middlewares,
    sslConnectInterceptor: (req, cltSocket, head) => {
      const hostname = req.url.split(':')[0]

      // 白名单域名跳过拦截
      const inWhiteList = !!matchUtil.matchHostname(whiteList, hostname, 'in whiteList')
      if (inWhiteList) {
        log.info(`为白名单域名，不拦截: ${hostname}`)
        return false
      }

      // 拦截配置中的域名，拦截
      const matched = matchUtil.matchHostname(intercepts, hostname, 'matched intercepts')
      if ((!!matched) === true) {
        log.debug(`拦截器拦截：${req.url}, matched:`, matched)
        return matched
      }

      return null
    },
    createIntercepts: (context) => {
      const rOptions = context.rOptions
      const interceptOpts = matchUtil.matchHostnameAll(intercepts, rOptions.hostname, 'get interceptOpts')
      if (!interceptOpts) {
        return
      }

      if (!interceptOpts._pathCache) {
        const cache = new LRUCache({
          maxSize: PATH_CACHE_MAX_SIZE,
          sizeCalculation: () => 1,
        })
        Object.defineProperty(interceptOpts, '_pathCache', { value: cache, enumerable: false, configurable: true })
      } else {
        const cached = interceptOpts._pathCache.get(rOptions.path)
        if (cached) {
          return cached
        }
      }

      const matchIntercepts = []
      const matchInterceptsOpts = {}
      for (const regexp in interceptOpts) {
        if (regexp === 'matched') continue

        const matched = matchUtil.isMatched(rOptions.path, regexp)
        if (matched == null) continue

        const interceptOpt = interceptOpts[regexp]
        interceptOpt.key = regexp

        if (interceptOpt.exclusions) {
          let isExcluded = false
          try {
            const exclusions = getExclusionArray(interceptOpt.exclusions)
            if (exclusions) {
              for (const exclusion of exclusions) {
                if (matchUtil.isMatched(rOptions.path, exclusion)) {
                  log.debug(`拦截器配置排除了path：${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}${rOptions.path}, exclusion: '${exclusion}'`)
                  isExcluded = true
                }
              }
            }
          } catch (e) {
            log.error(`判断拦截器是否排除当前path时出现异常, path: ${rOptions.path}, error:`, e)
          }
          if (isExcluded) continue
        }

        log.debug(`拦截器匹配path成功：${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}${rOptions.path}, regexp: ${regexp}`)

        for (const impl of interceptorImpls) {
          if (impl.is && impl.is(interceptOpt)) {
            let action = 'add'
            const matchedInterceptOpt = matchInterceptsOpts[impl.name]
            if (matchedInterceptOpt) {
              if (matchedInterceptOpt.order >= (interceptOpt.order || 0)) {
                log.warn(`duplicate interceptor: ${impl.name}, hostname: ${rOptions.hostname}`)
                continue
              }
              action = 'replace'
            }

            const interceptor = { name: impl.name, priority: impl.priority }
            if (impl.requestIntercept) {
              interceptor.requestIntercept = (context, req, res, ssl, next) => {
                return impl.requestIntercept(context, interceptOpt, req, res, ssl, next, matched, interceptOpts.matched)
              }
            } else if (impl.responseIntercept) {
              interceptor.responseIntercept = (context, req, res, proxyReq, proxyRes, ssl, next) => {
                return impl.responseIntercept(context, interceptOpt, req, res, proxyReq, proxyRes, ssl, next, matched, interceptOpts.matched)
              }
            }

            if (action === 'add') {
              matchIntercepts.push(interceptor)
            } else {
              matchIntercepts[matchedInterceptOpt.index] = interceptor
            }
            matchInterceptsOpts[impl.name] = {
              order: interceptOpt.order || 0,
              index: action === 'replace' ? matchedInterceptOpt.index : matchIntercepts.length - 1,
            }
          }
        }
      }

      matchIntercepts.sort((a, b) => a.priority - b.priority)
      interceptOpts._pathCache.set(rOptions.path, matchIntercepts)
      return matchIntercepts
    },
  }

  if (setting.rootCaFile) {
    options.caCertPath = setting.rootCaFile.certPath
    options.caKeyPath = setting.rootCaFile.keyPath
  }
  return options
}
