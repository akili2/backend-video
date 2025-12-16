const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Stockage des appels
const calls = new Map();

// Nettoyer les appels inactifs
setInterval(() => {
  const now = Date.now();
  for (const [code, call] of calls.entries()) {
    if (now - call.lastActivity > 3600000) { // 1 heure
      calls.delete(code);
      console.log(`🗑️ Nettoyage appel ${code} (inactif)`);
    }
  }
}, 300000); // Toutes les 5 minutes

io.on('connection', (socket) => {
  console.log(`✅ Nouveau client: ${socket.id}`);
  
  // Créer un appel
  socket.on('create-call', () => {
    const code = generateCallCode();
    const callId = uuidv4();
    
    calls.set(code, {
      id: callId,
      creator: socket.id,
      participants: [socket.id],
      status: 'waiting',
      createdAt: Date.now(),
      lastActivity: Date.now()
    });
    
    socket.join(callId);
    
    socket.emit('call-created', {
      callCode: code,
      callId: callId,
      socketId: socket.id
    });
    
    console.log(`📞 Appel créé: ${code} par ${socket.id}`);
  });

  // Rejoindre un appel
  socket.on('join-call', ({ callCode }) => {
    console.log(`🔗 ${socket.id} veut rejoindre ${callCode}`);
    
    const call = calls.get(callCode);
    
    if (!call) {
      socket.emit('error', { message: 'Code invalide' });
      return;
    }
    
    if (call.participants.length >= 2) {
      socket.emit('error', { message: 'Appel complet' });
      return;
    }
    
    // Ajouter le participant
    call.participants.push(socket.id);
    call.status = 'active';
    call.lastActivity = Date.now();
    
    socket.join(call.id);
    
    // Informer le créateur
    socket.to(call.id).emit('participant-joined', {
      participantId: socket.id,
      callCode: callCode
    });
    
    // Informer le nouveau participant
    socket.emit('call-joined', {
      callId: call.id,
      callCode: callCode,
      creatorId: call.creator,
      participantId: socket.id
    });
    
    console.log(`✅ ${socket.id} a rejoint ${callCode}`);
  });

  // Signaling WebRTC
  socket.on('webrtc-offer', ({ callCode, offer, to }) => {
    const call = calls.get(callCode);
    if (!call) return;
    
    console.log(`📤 Offer de ${socket.id} à ${to}`);
    socket.to(to).emit('webrtc-offer', {
      offer,
      from: socket.id,
      callCode
    });
  });

  socket.on('webrtc-answer', ({ callCode, answer, to }) => {
    const call = calls.get(callCode);
    if (!call) return;
    
    console.log(`📥 Answer de ${socket.id} à ${to}`);
    socket.to(to).emit('webrtc-answer', {
      answer,
      from: socket.id,
      callCode
    });
  });

  socket.on('webrtc-ice-candidate', ({ callCode, candidate, to }) => {
    const call = calls.get(callCode);
    if (!call) return;
    
    socket.to(to).emit('webrtc-ice-candidate', {
      candidate,
      from: socket.id,
      callCode
    });
  });

  // Gérer la déconnexion
  socket.on('disconnect', () => {
    console.log(`❌ Déconnexion: ${socket.id}`);
    
    for (const [code, call] of calls.entries()) {
      if (call.participants.includes(socket.id)) {
        call.participants = call.participants.filter(id => id !== socket.id);
        
        if (call.participants.length === 0) {
          calls.delete(code);
          console.log(`🗑️ Appel ${code} supprimé`);
        } else {
          // Informer l'autre participant
          socket.to(call.id).emit('participant-left', {
            participantId: socket.id
          });
          
          if (socket.id === call.creator) {
            // Transférer la création si le créateur part
            call.creator = call.participants[0];
          }
        }
        break;
      }
    }
  });

  socket.on('leave-call', ({ callCode }) => {
    console.log(`🚪 ${socket.id} quitte ${callCode}`);
    
    const call = calls.get(callCode);
    if (call) {
      call.participants = call.participants.filter(id => id !== socket.id);
      
      if (call.participants.length === 0) {
        calls.delete(callCode);
      } else {
        socket.to(call.id).emit('participant-left', {
          participantId: socket.id
        });
      }
      
      socket.leave(call.id);
    }
  });

  // Heartbeat
  socket.on('heartbeat', ({ callCode }) => {
    const call = calls.get(callCode);
    if (call) {
      call.lastActivity = Date.now();
    }
  });
});

// Générer un code d'appel
function generateCallCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Routes API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    calls: calls.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/call/:code', (req, res) => {
  const call = calls.get(req.params.code);
  if (call) {
    res.json({
      exists: true,
      participants: call.participants.length,
      status: call.status,
      createdAt: new Date(call.createdAt).toISOString()
    });
  } else {
    res.json({ exists: false });
  }
});

app.get('/api/stats', (req, res) => {
  const stats = {
    totalCalls: calls.size,
    activeCalls: Array.from(calls.values()).filter(c => c.status === 'active').length,
    waitingCalls: Array.from(calls.values()).filter(c => c.status === 'waiting').length,
    totalParticipants: Array.from(calls.values()).reduce((acc, c) => acc + c.participants.length, 0)
  };
  res.json(stats);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur WebRTC en écoute sur le port ${PORT}`);
  console.log(`📡 WebSocket prêt pour les connexions`);
});
