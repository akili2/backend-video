const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const calls = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Connecté:', socket.id);

  // Créer un appel
  socket.on('create-call', () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    calls.set(code, {
      creator: socket.id,
      participants: [socket.id],
      waiting: null
    });
    
    socket.join(code);
    socket.emit('call-created', { callCode: code });
    console.log(`📞 Appel créé: ${code}`);
  });

  // Rejoindre un appel
  socket.on('join-call', ({ callCode }) => {
    const call = calls.get(callCode);
    
    if (!call) {
      socket.emit('call-not-found');
      return;
    }
    
    if (call.participants.length >= 2) {
      socket.emit('call-full');
      return;
    }
    
    // Mettre en attente
    call.waiting = socket.id;
    socket.emit('call-waiting-for-approval');
    
    // Notifier le créateur
    io.to(call.creator).emit('participant-waiting', {
      participantId: socket.id
    });
    
    console.log(`⏳ ${socket.id} en attente pour ${callCode}`);
  });

  // Accepter
  socket.on('accept-participant', ({ callCode, participantId }) => {
    const call = calls.get(callCode);
    if (!call || call.creator !== socket.id) return;
    
    call.participants.push(participantId);
    call.waiting = null;
    
    // Faire rejoindre la room
    io.sockets.sockets.get(participantId)?.join(callCode);
    
    // Notifier les deux
    io.to(callCode).emit('participant-accepted', {
      participantId,
      participantCount: 2
    });
    
    console.log(`✅ ${participantId} accepté dans ${callCode}`);
  });

  // Refuser
  socket.on('reject-participant', ({ callCode, participantId }) => {
    const call = calls.get(callCode);
    if (!call || call.creator !== socket.id) return;
    
    call.waiting = null;
    io.to(participantId).emit('call-rejected');
    console.log(`❌ ${participantId} refusé`);
  });

  // WebRTC signaling
  socket.on('send-offer', ({ callCode, offer }) => {
    const call = calls.get(callCode);
    if (!call || call.participants.length < 2) return;
    
    const target = call.participants.find(id => id !== socket.id);
    if (target) {
      io.to(target).emit('receive-offer', { offer, from: socket.id });
    }
  });

  socket.on('send-answer', ({ callCode, answer }) => {
    const call = calls.get(callCode);
    if (!call || call.participants.length < 2) return;
    
    const target = call.participants.find(id => id !== socket.id);
    if (target) {
      io.to(target).emit('receive-answer', { answer, from: socket.id });
    }
  });

  socket.on('send-ice-candidate', ({ callCode, candidate }) => {
    const call = calls.get(callCode);
    if (!call || call.participants.length < 2) return;
    
    const target = call.participants.find(id => id !== socket.id);
    if (target) {
      io.to(target).emit('receive-ice-candidate', { candidate, from: socket.id });
    }
  });

  // Quitter
  socket.on('leave-call', ({ callCode }) => {
    const call = calls.get(callCode);
    if (call) {
      call.participants = call.participants.filter(id => id !== socket.id);
      if (call.participants.length === 0) {
        calls.delete(callCode);
      } else {
        io.to(callCode).emit('participant-left');
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Déconnecté:', socket.id);
    // Nettoyer les appels
    for (const [code, call] of calls.entries()) {
      if (call.participants.includes(socket.id)) {
        call.participants = call.participants.filter(id => id !== socket.id);
        if (call.participants.length === 0) {
          calls.delete(code);
        } else {
          io.to(code).emit('participant-left');
        }
      }
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', calls: calls.size });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur sur le port ${PORT}`);
});
