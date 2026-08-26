FROM node:20-slim

# yt-dlp needs python3 + ffmpeg for merging video/audio
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates && \
    pip3 install --break-system-packages -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
