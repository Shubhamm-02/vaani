FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/node.js"]
