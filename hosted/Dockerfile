# syntax=docker/dockerfile:1
# Build from the repo root: docker buildx build --platform linux/amd64 -f hosted/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY hosted ./hosted
RUN npm run build:hosted

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
# Full install, not --omit=dev: hono and @hono/node-server are devDependencies of the library and are runtime deps of the hosted service.
RUN npm ci && npm cache clean --force
COPY --from=build /app/dist-hosted ./dist-hosted
EXPOSE 8080
USER node
CMD ["node", "dist-hosted/hosted/src/server.js"]
