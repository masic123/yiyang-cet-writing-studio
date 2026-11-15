FROM node:24-bookworm-slim
WORKDIR /app

# Only remote parsing is used; no Torch models or GPU runtime are installed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 libglib2.0-0 libgl1 \
    && python3 -m venv /opt/mineru \
    && /opt/mineru/bin/pip install --no-cache-dir mineru==4.0.12 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8789 \
    DATABASE_PATH=/app/storage/cet-writing.sqlite ASSET_DIRECTORY=/app/out \
    MINERU_COMMAND=/opt/mineru/bin/mineru MINERU_HOME=/app/storage/mineru \
    MINERU_PARSE_SERVER_LOCAL_MODE=disabled
COPY server.mjs ./server.mjs
COPY out ./out
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 8789
CMD ["node", "server.mjs"]
