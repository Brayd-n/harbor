# 1. Install dependencies, build the React app, then drop dev dependencies
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build && npm prune --omit=dev

# 2. Runtime: Node runs the TypeScript server directly (type stripping), as the non-root "node" user
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY server server
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--max-old-space-size=200", "server/main.ts"]
