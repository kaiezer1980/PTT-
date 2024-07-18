const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const express = require('express');
const app = express();
const port = 8080;

// Création du serveur HTTP pour héberger les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

// Création du serveur WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Réception des messages du client
  ws.on('message', (message) => {
    console.log('Received:', message);
    
    // Diffusion du message à tous les autres clients
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
