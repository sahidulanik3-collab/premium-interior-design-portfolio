FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
