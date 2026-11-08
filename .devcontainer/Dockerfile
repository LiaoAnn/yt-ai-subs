FROM node:24-bookworm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# A pnpm store volume mounted here takes this directory's owner when the volume
# is (re)created empty. Without it a new volume belongs to root, and the
# postCreateCommand's pnpm install fails on permissions (the image has no sudo).
RUN mkdir -p /home/node/.local/share/pnpm/store && chown -R node:node /home/node/.local
