FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

EXPOSE 3000

CMD ["node", "src/index.js"]
