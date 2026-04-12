FROM node:20-slim

RUN npm install -g pnpm@9

WORKDIR /app

COPY . .

RUN rm -f pnpm-lock.yaml
RUN pnpm install
RUN pnpm --filter @workspace/ipremium-scan run build
RUN pnpm --filter @workspace/api-server run build

EXPOSE 3000

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
