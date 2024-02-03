FROM node:alpine

EXPOSE 8888 8889

RUN mkdir -p /opt/app
WORKDIR /opt/app
COPY package.json package-lock.json .
RUN npm install
COPY src/ .
CMD [ "npm", "start"]
