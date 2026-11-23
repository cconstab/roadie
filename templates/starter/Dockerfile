# {{TITLE}}: one small image. No npm dependencies, so there is no install step.
FROM node:26-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Pick up security fixes released since the base image was built, and remove
# npm and friends: the server never uses them.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app

# Only what the server needs at runtime (see .dockerignore).
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

# Which build this is, shown by /api/health. CI passes the release tag or main-<commit>.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
LABEL org.opencontainers.image.source="https://github.com/{{OWNER}}/{{REPO}}" \
      org.opencontainers.image.version=$APP_VERSION

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
