
FROM node:18

# Tạo thư mục chứa app
WORKDIR /usr/src/app

# Copy package.json trước để cache layer
COPY package*.json ./

# Cài đặt dependencies
RUN npm install --production

# Copy toàn bộ source sau cùng
COPY . .

# Render sẽ tự override biến môi trường
ENV NODE_ENV=production

# Expose port (Render sẽ dùng PORT env)
EXPOSE 10000

# Chạy server
CMD ["npm", "start"]
