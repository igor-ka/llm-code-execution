# Frontend dev server image (Vite). For a learning/local setup we run the dev
# server directly; a production build would use `npm run build` + a static server.
FROM node:22-slim

WORKDIR /app

# Copy .npmrc too: it sets legacy-peer-deps, needed because eslint-plugin-jsx-a11y's
# peer range still caps at eslint 9 while the project uses eslint 10.
COPY package.json package-lock.json .npmrc ./
RUN npm install

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
