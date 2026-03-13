FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN if [ -f "panolearn-backend/package.json" ]; then \
      cp -r panolearn-backend/. . && rm -rf panolearn-backend; \
    fi

RUN npm install --omit=dev

RUN npx prisma generate

# Show DB migration output clearly, then start
CMD sh -c 'echo "=== Running DB migration ===" && npx prisma db push --accept-data-loss && echo "=== DB ready ===" && node src/index.js'
