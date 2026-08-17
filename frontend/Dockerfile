# Frontend dev server image (Vite). For a learning/local setup we run the dev
# server directly; a production build would use `npm run build` + a static server.
FROM node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

# Slot 0's port. The frontend is the one service whose CONTAINER port follows the slot, because
# Vite's HMR client derives its websocket URL from the configured server port: with an uneven
# mapping the browser would load from the host port and then try to reach HMR on the container's,
# and hot reload would silently stop working. Compose therefore publishes it 1:1 and EXPOSE, which
# is metadata only and cannot be slot-aware at build time, names the default.
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
