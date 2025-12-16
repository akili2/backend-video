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
  }
});

// Stockage temporaire des appels
const activeCalls = new Map();

// Générer un code d'appel unique
function generateCallCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('Nouvelle connexion:', socket.id);

  // Créer un nouvel appel
  socket.on('create-call', () => {
    const callCode = generateCallCode();
    const callId = uuidv4();
    
    activeCalls.set(callCode, {
      callId,
      creator: socket.id,
      participants: [socket.id],
      offer: null,
      answer: null,
      iceCandidates: []
    });

    socket.join(callId);
    socket.emit('call-created', { callCode, callId });
    console.log(`Appel créé: ${callCode} par ${socket.id}`);
  });

// Mettez à jour la partie 'join-call'
socket.on('join-call', ({ callCode }) => {
    const callData = activeCalls.get(callCode);
    
    if (!callData) {
      socket.emit('call-not-found');
      return;
    }

    if (callData.participants.length >= 2) {
      socket.emit('call-full');
      return;
    }

    callData.participants.push(socket.id);
    socket.join(callData.callId);
    
    // Informer TOUS les participants du nouvel arrivant
    io.to(callData.callId).emit('participant-joined', { 
      participantId: socket.id,
      participantCount: callData.participants.length 
    });
    
    // Envoyer la liste des participants existants au nouveau venu
    const otherParticipants = callData.participants.filter(id => id !== socket.id);
    
    socket.emit('call-joined', { 
      callId: callData.callId, 
      creatorId: callData.creator,
      participants: callData.participants,
      participantCount: callData.participants.length
    });
    
    console.log(`Participant ${socket.id} a rejoint l'appel ${callCode}. Total: ${callData.participants.length}`);
});

  // Envoyer une offre WebRTC
  socket.on('send-offer', ({ callCode, offer }) => {
    const callData = activeCalls.get(callCode);
    if (callData) {
      callData.offer = offer;
      socket.to(callData.callId).emit('receive-offer', { offer, from: socket.id });
    }
  });

  // Envoyer une réponse WebRTC
  socket.on('send-answer', ({ callCode, answer }) => {
    const callData = activeCalls.get(callCode);
    if (callData) {
      callData.answer = answer;
      socket.to(callData.callId).emit('receive-answer', { answer, from: socket.id });
    }
  });

  // Échanger les candidats ICE
  socket.on('send-ice-candidate', ({ callCode, candidate }) => {
    const callData = activeCalls.get(callCode);
    if (callData) {
      socket.to(callData.callId).emit('receive-ice-candidate', { 
        candidate, 
        from: socket.id 
      });
    }
  });

  // Gérer la déconnexion
  socket.on('disconnect', () => {
    console.log('Déconnexion:', socket.id);
    
    // Nettoyer les appels inactifs
    for (const [callCode, callData] of activeCalls.entries()) {
      if (callData.participants.includes(socket.id)) {
        // Informer les autres participants
        socket.to(callData.callId).emit('participant-left', { participantId: socket.id });
        
        // Si le créateur se déconnecte, supprimer l'appel
        if (socket.id === callData.creator) {
          activeCalls.delete(callCode);
          console.log(`Appel ${callCode} supprimé (créateur déconnecté)`);
        }
      }
    }
  });
});

// Route de santé pour Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    activeCalls: activeCalls.size,
    timestamp: new Date().toISOString()
  });
});

// Route pour vérifier un code d'appel
app.get('/api/verify-call/:callCode', (req, res) => {
  const { callCode } = req.params;
  const callData = activeCalls.get(callCode);
  
  if (callData) {
    res.json({ 
      exists: true, 
      participants: callData.participants.length 
    });
  } else {
    res.json({ exists: false });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Serveur backend en écoute sur le port ${PORT}`);
});
// Ajoutez cette partie dans le backend
socket.on('leave-call', ({ callCode }) => {
  const callData = activeCalls.get(callCode);
  if (callData) {
    // Retirer le participant
    callData.participants = callData.participants.filter(id => id !== socket.id);
    
    if (callData.participants.length === 0) {
      // Supprimer l'appel si plus de participants
      activeCalls.delete(callCode);
      console.log(`Appel ${callCode} supprimé (plus de participants)`);
    } else {
      // Informer les autres participants
      socket.to(callData.callId).emit('participant-left', { 
        participantId: socket.id,
        participantCount: callData.participants.length
      });
    }
  }
});
