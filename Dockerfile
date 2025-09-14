# Sử dụng Node.js LTS
FROM node:22

# Tạo thư mục app
WORKDIR /usr/src/app

# Copy package.json và package-lock.json trước để cài đặt dependencies
COPY package*.json ./

# Cài đặt dependencies
RUN npm install --production

# Copy toàn bộ source code vào container
COPY . .

# Biến môi trường (Render sẽ override bằng .env)
ENV NODE_ENV=production

# Mở port
EXPOSE 10000

# Chạy server
CMD ["npm", "start"]
