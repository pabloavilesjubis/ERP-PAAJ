# ─── Stage 1: deps (incluye devDeps para poder compilar) ───────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ─── Stage 2: build (compila TS → dist/) ────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3: runtime (solo prod deps + dist + recursos) ────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Solo prod deps. Las migrations corren vía `node dist/...`, NO necesitan tsx.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
# Compilados + schemas oficiales MH (cargados por AJV en runtime)
COPY --from=build /app/dist ./dist
COPY --from=build /app/schemas ./dist/schemas
# Migrations SQL. Se montan donde el dist los resuelve:
#   /app/dist/src/db/migrate.js → __dirname=/app/dist/src/db
#   path.resolve(__dirname, '../../db/migrations') = /app/dist/db/migrations
COPY --from=build /app/db ./dist/db
# Persistencia de PDFs/JSONs/tickets generados
RUN mkdir -p /app/data
# Ownership: TODO /app es de node, incluyendo node_modules y dist.
# Esto evita los EACCES post-deploy y permite que `npm` pueda escribir
# si en el futuro alguien necesita ejecutar comandos como user `node`.
RUN chown -R node:node /app
EXPOSE 3000
USER node
CMD ["node", "dist/src/index.js"]
