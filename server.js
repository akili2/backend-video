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
    socket.emit('call-created', { 
      callCode, 
      callId,
      participantCount: 1
    });
    console.log(`Appel créé: ${callCode} par ${socket.id}. Participants: 1`);
  });

  // Rejoindre un appel existant
  socket.on('join-call', ({ callCode }) => {
    console.log(`Tentative de rejoindre l'appel ${callCode} par ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    
    if (!callData) {
      console.log(`Appel ${callCode} non trouvé`);
      socket.emit('call-not-found');
      return;
    }

    if (callData.participants.length >= 2) {
      console.log(`Appel ${callCode} complet (${callData.participants.length}/2)`);
      socket.emit('call-full');
      return;
    }

    // Ajouter le nouveau participant
    callData.participants.push(socket.id);
    socket.join(callData.callId);
    
    console.log(`Participant ${socket.id} ajouté. Total: ${callData.participants.length}`);
    
    // Informer TOUS les participants du nouvel arrivant
    io.to(callData.callId).emit('participant-joined', { 
      participantId: socket.id,
      participantCount: callData.participants.length 
    });
    
    // Envoyer les infos au nouveau participant
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
    console.log(`Offre reçue pour l'appel ${callCode} de ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    if (callData) {
      callData.offer = offer;
      socket.to(callData.callId).emit('receive-offer', { 
        offer, 
        from: socket.id 
      });
      console.log(`Offre transmise aux autres participants`);
    }
  });

  // Envoyer une réponse WebRTC
  socket.on('send-answer', ({ callCode, answer }) => {
    console.log(`Réponse reçue pour l'appel ${callCode} de ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    if (callData) {
      callData.answer = answer;
      socket.to(callData.callId).emit('receive-answer', { 
        answer, 
        from: socket.id 
      });
      console.log(`Réponse transmise`);
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

  // Gérer la sortie volontaire d'un appel
  socket.on('leave-call', ({ callCode }) => {
    console.log(`Tentative de quitter l'appel ${callCode} par ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    if (callData) {
      console.log(`Appel trouvé. Participants avant: ${callData.participants.length}`);
      
      // Retirer le participant de la liste
      callData.participants = callData.participants.filter(id => id !== socket.id);
      
      console.log(`Participants après: ${callData.participants.length}`);
      
      if (callData.participants.length === 0) {
        // Supprimer l'appel si plus de participants
        activeCalls.delete(callCode);
        console.log(`Appel ${callCode} supprimé (plus de participants)`);
      } else {
        // Informer les autres participants
        io.to(callData.callId).emit('participant-left', { 
          participantId: socket.id,
          participantCount: callData.participants.length
        });
        console.log(`Notification envoyée aux autres participants`);
      }
      
      // Quitter la room Socket.io
      socket.leave(callData.callId);
    } else {
      console.log(`Appel ${callCode} non trouvé pour leave-call`);
    }
  });

  // Gérer la déconnexion
  socket.on('disconnect', () => {
    console.log('Déconnexion du socket:', socket.id);
    
    // Nettoyer les appels inactifs
    for (const [callCode, callData] of activeCalls.entries()) {
      if (callData.participants.includes(socket.id)) {
        console.log(`Retrait de ${socket.id} de l'appel ${callCode}`);
        
        // Retirer le participant de la liste
        callData.participants = callData.participants.filter(id => id !== socket.id);
        
        if (callData.participants.length === 0) {
          // Supprimer l'appel si plus de participants
          activeCalls.delete(callCode);
          console.log(`Appel ${callCode} supprimé (plus de participants après déconnexion)`);
        } else {
          // Informer les autres participants
          io.to(callData.callId).emit('participant-left', { 
            participantId: socket.id,
            participantCount: callData.participants.length
          });
          console.log(`Notification envoyée pour la déconnexion de ${socket.id}`);
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
      participants: callData.participants.length,
      maxParticipants: 2
    });
  } else {
    res.json({ exists: false });
  }
});

// Route pour lister les appels actifs (debug)
app.get('/api/active-calls', (req, res) => {
  const calls = [];
  for (const [code, data] of activeCalls.entries()) {
    calls.push({
      code,
      participants: data.participants.length,
      creator: data.creator
    });
  }
  res.json({ calls });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur backend en écoute sur le port ${PORT}`);
});
