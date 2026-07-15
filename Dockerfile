FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium

COPY config ./config
COPY data ./data
COPY scripts ./scripts
COPY server ./server
COPY ops ./ops

RUN useradd --create-home --uid 10001 oracle \
  && chown -R oracle:oracle /app

USER oracle
EXPOSE 8080

CMD ["node", "server/api.cjs"]
