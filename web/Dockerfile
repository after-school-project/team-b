FROM node:24.12.0-bookworm-slim

WORKDIR /app
RUN chown node:node /app && install -d -o node -g node -m 0700 /app/.seed

USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci

COPY --chown=node:node . .

EXPOSE 3000
CMD ["sh", "-c", "npm run db:setup && exec npm run dev -- --hostname 0.0.0.0"]
