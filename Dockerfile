FROM node:18-bullseye-slim

# Instalar dependencias del sistema para Puppeteer (Chrome)
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libcups2 \
    libxss1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

# Instalamos las dependencias normales (con las versiones fijas para estabilidad)
RUN npm install

# ---------------------------------------------------------------------
# EL TRUCO MAESTRO:
# Forzamos la instalación de la ÚLTIMA versión de wwebjs
# justo antes de copiar el código. Esto asegura que la imagen
# siempre tenga lo más nuevo al construirse.
# ---------------------------------------------------------------------
RUN npm install whatsapp-web.js@latest

COPY . .

# Variables de entorno para que use el Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "src/server.js"]