FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY src/ ./src/
COPY tsconfig.json ./

ENV API_PORT=3210
EXPOSE 3210

CMD ["bun", "run", "src/index.ts"]
