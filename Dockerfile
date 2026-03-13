FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN if [ -f "panolearn-backend/package.json" ]; then \
      cp -r panolearn-backend/. . && rm -rf panolearn-backend; \
    fi

RUN npm install --omit=dev

RUN npx prisma generate

# Run DB migration then start server
CMD npx prisma db push --accept-data-loss && node src/index.js
