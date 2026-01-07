FROM node:18-slim

USER node
WORKDIR /home/node/app

# Copy and install dependencies
COPY --chown=node:node package*.json ./
RUN npm install --production

# Copy application code
COPY --chown=node:node . .

# Hugging Face port
EXPOSE 7860

# Start server
CMD ["node", "server.js"]
