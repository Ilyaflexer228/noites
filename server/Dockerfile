# Production Dockerfile для WebSocket CRDT сервера «Наши планы 🎄»
FROM node:20-alpine

WORKDIR /app

# Копируем описание зависимостей
COPY package.json ./

# Устанавливаем production зависимости
RUN npm install --omit=dev

# Копируем исходный код
COPY server.mjs ./

# Создаем том для постоянного хранения документов
VOLUME /app/data

# Порт сервиса
EXPOSE 1234

ENV NODE_ENV=production
ENV PORT=1234
ENV DATA_DIR=/app/data
ENV INVITE_SECRET=ny2027-friends

CMD ["node", "server.mjs"]
