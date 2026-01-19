# Usamos una imagen base de Node robusta
FROM node:18-slim

# --- 1. INSTALACIÓN DE DEPENDENCIAS DEL SISTEMA PARA CHROME ---
# Esto es lo que necesitas para que Puppeteer funcione en Linux
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# --- 2. CONFIGURACIÓN DEL PROYECTO ---
WORKDIR /usr/src/app

# Copiamos primero el package.json para aprovechar la caché de Docker
COPY package*.json ./

# Instalamos las dependencias de Node
# Usamos --production para no instalar cosas de desarrollo
RUN npm install

# Copiamos el resto del código (server.js, etc.)
COPY . .

# --- 3. VARIABLES DE ENTORNO ---
# Le decimos a Puppeteer que NO descargue Chrome otra vez (usaremos el instalado arriba)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Puerto
EXPOSE 3000

# Comando de inicio
CMD [ "node", "src/server.js" ]