# tmuxlab in a container: its own tmux, shells and agents, with the home folder on a volume.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/vendor.mjs scripts/
RUN npm ci --ignore-scripts && npm rebuild node-pty && mkdir -p public && node scripts/vendor.mjs && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git openssh-client ca-certificates curl procps less vim-tiny tini \
  && rm -rf /var/lib/apt/lists/* \
  && userdel -r node && useradd -m -u 1000 -s /bin/bash dev
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/public/vendor public/vendor
COPY package.json server.js ./
COPY lib lib
COPY public public
COPY scripts/pair.mjs scripts/
COPY bin bin
COPY skills skills
RUN ln -s /app/bin/tmuxlab.mjs /usr/local/bin/tmuxlab
USER dev
# global npm installs (e.g. npm i -g @anthropic-ai/claude-code) land in the home volume and survive upgrades
ENV HOME=/home/dev NPM_CONFIG_PREFIX=/home/dev/.npm-global PATH=/home/dev/.npm-global/bin:$PATH \
    PORT=7681 HOST=0.0.0.0 TMUXLAB_CONTAINER=1 SHELL=/bin/bash LANG=C.UTF-8
WORKDIR /home/dev
VOLUME /home/dev
EXPOSE 7681
ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/server.js"]
