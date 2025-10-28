FROM node:22-alpine

WORKDIR /usr/src/app

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm && corepack prepare pnpm@10.19.0 --activate

COPY . .
RUN pnpm install && pnpm build

EXPOSE 9080
ENTRYPOINT ["pnpm", "backend:run"]
