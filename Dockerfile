# ---- build stage: compile TS -> dist/ and bundle the client -> public/ ----
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
# Copy the BUILT public/ (includes the esbuild-generated vision-client.js),
# not the build-context copy, so the runtime image always has the fresh bundle.
COPY --from=build /app/public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]