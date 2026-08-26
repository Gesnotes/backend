FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ git openssl
COPY package*.json ./
RUN npm ci
COPY . .
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.* ./
COPY package*.json ./
EXPOSE 4000
CMD ["node", "dist/index.js"]
