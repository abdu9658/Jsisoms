FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node","--disable-warning=ExperimentalWarning","server.js"]
