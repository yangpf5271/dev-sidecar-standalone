// DNS-over-HTTPS (RFC 8484) 客户端
// 原实现依赖 dns-over-http@0.2.0(2018 年后未维护,传递依赖
// accept/boom/hoek 三个 hapi 弃用包且未声明 is-browser),
// 此处用已有的 dns-packet 按标准线格式直接实现,清理 5 个依赖
const http = require('node:http')
const https = require('node:https')
const dnsPacket = require('dns-packet')
const BaseDNS = require('./base')
const HttpsAgent = require('../proxy/common/ProxyHttpsAgent')
const Agent = require('../proxy/common/ProxyHttpAgent')

function createAgent (dnsServer) {
  return new (dnsServer.startsWith('https:') ? HttpsAgent : Agent)({
    keepAlive: true,
    timeout: 4000,
  })
}

module.exports = class DNSOverHTTPS extends BaseDNS {
  constructor (dnsName, cacheSize, preSetIpList, dnsServer, dnsFamily, dnsServerName) {
    super(dnsServer.replace(/\s+/, ''), dnsFamily, dnsName, 'HTTPS', cacheSize, preSetIpList)
    this.dnsServerName = dnsServerName
    this.agent = createAgent(this.dnsServer)
  }

  _dnsQueryPromise (hostname, type = 'A') {
    // RFC 8484 线格式: POST 是协议 MUST(所有 DoH 服务端都支持),
    // 结果缓存由 BaseDNS 自身负责,无需依赖 GET 的服务端缓存
    const packet = dnsPacket.encode({
      type: 'query',
      id: 0,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type, name: hostname }],
    })

    const url = new URL(this.dnsServer)
    const isHttps = url.protocol === 'https:'
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/dns-message',
        'Content-Length': packet.length,
      },
      agent: this.agent,
    }
    if (this.dnsServerName) {
      // 设置SNI
      options.servername = this.dnsServerName
      options.rejectUnauthorized = false
    }
    if (this.dnsFamily === 6) {
      options.family = 6
    }

    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(options, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`DoH server responded ${res.statusCode}`))
            }
            const decoded = dnsPacket.decode(Buffer.concat(chunks))
            resolve({ answers: decoded.answers || [] })
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('timeout', () => req.destroy(new Error('DoH query timeout')))
      req.on('error', reject)
      req.end(packet)
    })
  }
}
