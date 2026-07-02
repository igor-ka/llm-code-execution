# Backend service image. Note: this container talks to the host Docker daemon
# (socket mounted in docker-compose) to launch sandbox containers.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 8000
CMD ["node", "dist/index.js"]
