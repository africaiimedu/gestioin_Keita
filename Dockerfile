FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p data/uploads && chown -R node:node data

USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4317/api/sante > /dev/null || exit 1

CMD ["node", "src/server.js"]
