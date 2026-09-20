FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY . .
# .dockerignore must exclude: **/node_modules, apps/mobile/android, apps/mobile/.expo, firmware, .env*
RUN npm ci --workspace apps/api --workspace packages/contracts --include-workspace-root
RUN npm run build -w packages/contracts \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w apps/api

FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# `prisma` must be in apps/api "dependencies" (not devDependencies) for migrate deploy at start-up
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/server.js"]
