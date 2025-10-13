# ---- Base image ----
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- Dependencies (production only) ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---- Build (devDependencies needed) ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# ---- Final image ----
FROM base
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Optionally copy any other needed files (e.g. migrations, public assets)

# Expose port for HTTP mode
EXPOSE 3000

CMD ["node", "dist/app.js"]
