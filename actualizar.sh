#!/bin/bash

echo "🔄 Iniciando actualización de WhatsApp Service..."

# 1. Bajar los contenedores actuales
docker-compose down

# 2. IMPORTANTE: Reconstruir la imagen. 
# Gracias al cambio en el Dockerfile, esto descargará la última versión de whatsapp-web.js
docker-compose build --no-cache whatsapp-api

# 3. Levantar de nuevo
docker-compose up -d

echo "Sistema actualizado y reiniciado. Revisa los logs con: docker-compose logs -f"