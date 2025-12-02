FROM node:20-slim

WORKDIR /usr/src/app

# Tắt logs NPM cho nhẹ
ENV NPM_CONFIG_LOGLEVEL=warn

# Cài Chromium (cho Puppeteer)
RUN apt-get update && apt-get install -y chromium && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["npm", "start"]
