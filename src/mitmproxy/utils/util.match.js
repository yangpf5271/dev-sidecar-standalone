// 修改版：使用本地 merge 替代 @docmirror/dev-sidecar/src/merge
const lodash = require('lodash')
const log = require('./util.log.server')
const mergeApi = require('../../core/merge')

const { LRUCache } = require('lru-cache')

const urlRegexpCache = new LRUCache({
  maxSize: 512,
  sizeCalculation: () => 1,
})

function isMatched (url, regexp) {
  if (regexp === '.*' || regexp === '*' || regexp === 'true' || regexp === true) {
    return [url]
  }
  try {
    let compiled = urlRegexpCache.get(regexp)
    if (!compiled) {
      let urlRegexp = regexp
      if (regexp[0] === '*' || regexp[0] === '?' || regexp[0] === '+') {
        urlRegexp = `.${regexp}`
      }
      compiled = new RegExp(urlRegexp)
      urlRegexpCache.set(regexp, compiled)
    }
    return url.match(compiled)
  } catch {
    log.error('匹配串有问题:', regexp)
    return null
  }
}

function domainRegexply (target) {
  if (target === '.*' || target === '*' || target === 'true' || target === true) {
    return '^.*$'
  }
  return `^${target.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`
}

function domainMapRegexply (hostMap) {
  if (hostMap == null) {
    return { origin: {} }
  }
  const regexpMap = {}
  const origin = {}
  lodash.each(hostMap, (value, domain) => {
    try {
      if (domain[0] === '.') {
        if (hostMap[`*${domain}`] != null) {
          return
        }
        domain = `*${domain}`
      }
      if (domain.includes('*') || domain[0] === '^') {
        const regDomain = domain[0] !== '^' ? domainRegexply(domain) : domain
        regexpMap[regDomain] = value
        if (domain.indexOf('*') === 0 && domain.lastIndexOf('*') === 0) {
          origin[domain] = value
        }
      } else {
        origin[domain] = value
      }
    } catch (e) {
      log.error('匹配串有问题:', domain, e)
    }
  })
  regexpMap.origin = origin
  return regexpMap
}

function matchHostname (hostMap, hostname, action) {
  if (hostMap == null) {
    log.warn(`matchHostname: ${action}: '${hostname}' Not-Matched, hostMap is null`)
    return null
  }
  if (hostMap.origin == null) {
    log.warn(`matchHostname: ${action}: '${hostname}' Not-Matched, hostMap.origin is null`)
    return null
  }
  let value = hostMap.origin[hostname]
  if (value != null) {
    log.debug(`matchHostname: ${action}: '${hostname}' -> { "${hostname}": ${JSON.stringify(value)} }`)
    return value
  }
  value = hostMap.origin[`*.${hostname}`]
  if (value != null) {
    log.debug(`matchHostname: ${action}: '${hostname}' -> { "*.${hostname}": ${JSON.stringify(value)} }`)
    return value
  }
  value = hostMap.origin[`*${hostname}`]
  if (value != null) {
    log.debug(`matchHostname: ${action}: '${hostname}' -> { "*${hostname}": ${JSON.stringify(value)} }`)
    return value
  }
  for (const regexp in hostMap) {
    if (regexp === 'origin') continue
    if (hostname.match(regexp)) {
      value = hostMap[regexp]
      log.debug(`matchHostname: ${action}: '${hostname}' -> { "${regexp}": ${JSON.stringify(value)} }`)
      return value
    }
  }
  log.debug(`matchHostname: ${action}: '${hostname}' Not-Matched`)
}

function matchHostnameAll (hostMap, hostname, action) {
  if (hostMap == null) {
    log.warn(`matchHostname-all: ${action}: '${hostname}', hostMap is null`)
    return null
  }
  if (hostMap.origin == null) {
    log.warn(`matchHostname-all: ${action}: '${hostname}', hostMap.origin is null`)
    return null
  }
  let values = {}
  let value
  for (const regexp in hostMap) {
    if (regexp === 'origin') continue
    const matched = hostname.match(regexp)
    if (matched) {
      value = hostMap[regexp]
      log.debug(`matchHostname-one: ${action}: '${hostname}' -> { "${regexp}": ${JSON.stringify(value)} }`)
      values = mergeApi.doMerge(values, value)
      if (matched.length > 1) {
        if (values.matched) {
          matched.shift()
          values.matched = [...values.matched, ...matched]
          if (matched.groups) {
            values.matched.groups = mergeApi.doMerge(values.matched.groups, matched.groups)
          } else {
            values.matched.groups = matched.groups
          }
        } else {
          values.matched = matched
        }
      }
    }
  }
  value = hostMap.origin[`*${hostname}`]
  if (value) {
    log.debug(`matchHostname-one: ${action}: '${hostname}' -> { "*${hostname}": ${JSON.stringify(value)} }`)
    values = mergeApi.doMerge(values, value)
  }
  value = hostMap.origin[`*.${hostname}`]
  if (value) {
    log.debug(`matchHostname-one: ${action}: '${hostname}' -> { "*.${hostname}": ${JSON.stringify(value)} }`)
    values = mergeApi.doMerge(values, value)
  }
  value = hostMap.origin[hostname]
  if (value) {
    log.debug(`matchHostname-one: ${action}: '${hostname}' -> { "${hostname}": ${JSON.stringify(value)} }`)
    values = mergeApi.doMerge(values, value)
  }
  if (!lodash.isEmpty(values)) {
    mergeApi.deleteNullItems(values)
    log.debug(`matchHostname-all: ${action}: '${hostname}':`, JSON.stringify(values))
    return values
  } else {
    log.debug(`matchHostname-all: ${action}: '${hostname}' Not-Matched`)
  }
}

module.exports = {
  isMatched,
  domainMapRegexply,
  matchHostname,
  matchHostnameAll,
}
