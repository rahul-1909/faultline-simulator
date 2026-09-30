# Build React Dashboard
FROM node:20-alpine AS build

WORKDIR /app

COPY dashboard/package.json ./
RUN npm install

COPY dashboard/ ./
RUN npm run build

# Serve with lightweight Nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
