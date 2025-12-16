const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static("public"));

// Route pour servir la page d'accueil (index.html)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Route pour servir la page de chat vidéo (room.html)
// Cette route doit être définie une seule fois, au démarrage du serveur
app.get('/room.html', (req, res) => {
  res.sendFile(__dirname + '/public/room.html');
});

io.on("connection", (socket) => {
  console.log('Un utilisateur s\'est connecté :', socket.id);

  // Garder une trace de la salle et du nom d'utilisateur pour ce socket
  let currentRoomId;
  let currentUsername;

  socket.on("join-room", (roomId, username) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients >= 2) {
      socket.emit('room-full', roomId);
      console.log(`Salle ${roomId} pleine. ${socket.id} n'a pas pu rejoindre.`);
      return;
    }

    socket.join(roomId);
    currentRoomId = roomId;
    currentUsername = username;

    console.log(`L'utilisateur ${socket.id} (${username}) a rejoint la salle ${roomId}. Clients dans la salle: ${numClients + 1}`);

    if (numClients === 1) {
      // Si un autre utilisateur est déjà dans la salle, notifier l'utilisateur existant
      // que le nouveau s'est connecté pour initier la connexion WebRTC
      socket.to(roomId).emit('user-connected', socket.id, username);
    }
  });

  // Relayer les signaux WebRTC (offre, réponse, candidats ICE)
  socket.on("signal", (data) => {
    io.to(data.to).emit("signal", {
      from: socket.id, // On utilise socket.id comme source fiable
      signal: data.signal,
    });
  });

  // Gérer les messages du chat
  socket.on("chat-message", (msg) => {
    if (currentRoomId && currentUsername) {
      io.to(currentRoomId).emit("chat-message", {
        username: currentUsername,
        message: msg,
      });
    }
  });

  // Gérer la déconnexion de l'utilisateur
  socket.on("disconnect", () => {
    console.log('Un utilisateur s\'est déconnecté :', socket.id);
    if (currentRoomId) {
      // Notifier les autres utilisateurs que quelqu'un s'est déconnecté
      socket.to(currentRoomId).emit("user-disconnected", socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Le serveur écoute sur le port ${PORT}`);
});
