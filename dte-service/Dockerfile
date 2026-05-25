FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/schemas ./dist/schemas
# Directorio persistente para DTEs/clientes/idempotency/files. Owner=node
# para que el proceso pueda escribir cuando el volumen se monta vacío.
RUN mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3000
USER node
CMD ["node", "dist/src/index.js"]
