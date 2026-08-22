# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ca-certificates wget

COPY --from=build /app/node_modules ./node_modules
COPY . .

# 默认端口（HTTP: 31180, HTTPS/MITM: 31181）
EXPOSE 31180 31181

# 数据卷：持久化 CA 证书
VOLUME /root/.dev-sidecar

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:31180/ || exit 1

ENTRYPOINT ["node", "/app/index.js"]
CMD []
