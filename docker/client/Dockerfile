# syntax=docker/dockerfile:1

FROM node:16
ENV NODE_ENV=production
ENV HOSTNAME=client
ENV SERVERURL=http://server:3000
RUN apt-get update && \
    apt-get install -y openssh-server openssl netcat telnet wget
WORKDIR /app
COPY ../.. .
RUN chmod +x ./docker/scripts/* \
    && mkdir /app/data \
    && /app/docker/scripts/build-random-files-for-server.js 5 /app/data
CMD [ "/app/docker/scripts/load_env_vars.sh", "/app/dist/squirt-client.js", "--headless" ]
