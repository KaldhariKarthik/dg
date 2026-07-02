# syntax=docker/dockerfile:1

# ---- build stage: compile TS -> dist/ and bundle client -> public/ ----
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage: prod deps + compiled output only ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
