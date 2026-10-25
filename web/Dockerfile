# =====================================================================
# FlowBoard web tier — multi-stage build
#   Stage 1 (node):  npm ci + vite build  -> static files in /app/dist
#   Stage 2 (nginx): only the static files + nginx.conf (no Node, no source)
# Build: docker build -t flowboard-web:1.0.0 ./web
# =====================================================================

# ---------- Stage 1: build the React app ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: serve with Nginx ----------
# 1.28+ is required for "server ... resolve" in the upstream block
FROM nginx:1.28-alpine

LABEL org.opencontainers.image.title="flowboard-web" \
      org.opencontainers.image.description="FlowBoard React frontend + reverse proxy / load balancer" \
      org.opencontainers.image.version="1.0.0"

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/flowboard.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/nginx-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
