# Frontend dev server image (Vite). For a learning/local setup we run the dev
# server directly; a production build would use `npm run build` + a static server.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
