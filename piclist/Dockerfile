FROM node:20-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && npm config set registry https://registry.npmmirror.com \
    && npm install -g piclist@latest

WORKDIR /root/.piclist
EXPOSE 36677

ENTRYPOINT ["picgo-server"]
