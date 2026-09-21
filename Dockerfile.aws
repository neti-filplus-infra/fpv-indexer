# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN --mount=type=secret,id=DATABASE_URL \
    if [ -f /run/secrets/DATABASE_URL ]; then \
      export DATABASE_URL="$(cat /run/secrets/DATABASE_URL)"; \
    else \
      export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/db"; \
    fi; \
    npm run schema:emit
RUN npm run build

FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3000
RUN apk add --no-cache openssl

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

CMD ["node", "dist/main.js"]
