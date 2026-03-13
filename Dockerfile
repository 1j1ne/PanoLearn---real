FROM node:20-slim

# Install OpenSSL (required by Prisma)
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# If files are inside a subfolder, move them up
RUN if [ -f "panolearn-backend/package.json" ]; then \
      cp -r panolearn-backend/. . && rm -rf panolearn-backend; \
    fi

RUN npm install --omit=dev

RUN npx prisma generate

EXPOSE 3000

CMD ["node", "src/index.js"]
