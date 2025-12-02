FROM node:20-alpine

# Thư mục chứa app
WORKDIR /usr/src/app

# Copy package.json và lock file để cache
COPY package*.json ./

# Cài dependencies (bỏ dev để nhẹ)
RUN npm install --omit=dev

# Copy toàn bộ source code
COPY . .

# Environment (Render sẽ override)
ENV NODE_ENV=production

# Expose port (Render sẽ dùng biến PORT)
EXPOSE 10000

# Chạy server
CMD ["npm", "start"]
