FROM node:24-alpine3.23 AS build-frontend

RUN corepack enable
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install
COPY version.txt /app/
COPY frontend/patches ./patches
COPY frontend/public ./public
COPY frontend/scripts ./scripts
COPY frontend/src ./src
COPY frontend/index.html frontend/svelte.config.js frontend/tsconfig.json frontend/vite.config.ts frontend/vitest-setup.ts ./
RUN pnpm run build

FROM docker.io/golang:alpine3.23 AS build-backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=build-frontend /app/cmd/lightjj/frontend-dist ./cmd/lightjj/frontend-dist
RUN CGO_ENABLED=0 go build -tags embed ./cmd/lightjj

FROM docker.io/alpine:3.23 AS build-jj
RUN apk add --no-cache cargo
RUN cargo install cargo-binstall --locked
RUN cargo binstall --strategies crate-meta-data jj-cli

FROM docker.io/alpine:3.23
COPY --from=build-jj /root/.cargo/bin/jj /usr/local/bin/jj
COPY --from=build-backend /app/lightjj /app/lightjj
RUN mkdir -p /.config/jj && chmod -R 777 .config
USER 1000:1000
EXPOSE 8080
WORKDIR /repo
CMD [ "/app/lightjj", "--addr",  "0.0.0.0:8080" ]
