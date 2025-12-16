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
  console.log('✅ Nouvelle connexion:', socket.id);

  // Créer un nouvel appel
  socket.on('create-call', () => {
    const callCode = generateCallCode();
    const callId = uuidv4();
    
    activeCalls.set(callCode, {
      callId,
      creator: socket.id,
      participants: [socket.id],
      waitingParticipant: null,
      offer: null,
      answer: null,
      iceCandidates: [],
      createdAt: new Date().toISOString()
    });

    socket.join(callId);
    socket.emit('call-created', { 
      callCode, 
      callId,
      participantCount: 1
    });
    console.log(`📞 Appel créé: ${callCode} par ${socket.id}. Participants: 1`);
  });

  // Rejoindre un appel existant
  socket.on('join-call', ({ callCode }) => {
    console.log(`🔗 Tentative de rejoindre l'appel ${callCode} par ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    
    if (!callData) {
      console.log(`❌ Appel ${callCode} non trouvé`);
      socket.emit('call-not-found');
      return;
    }

    // Vérifier si l'utilisateur est déjà dans l'appel
    if (callData.participants.includes(socket.id)) {
      console.log(`ℹ️ Utilisateur ${socket.id} déjà dans l'appel`);
      socket.emit('already-in-call', { callId: callData.callId });
      return;
    }

    if (callData.participants.length >= 2) {
      console.log(`🚫 Appel ${callCode} complet (${callData.participants.length}/2)`);
      socket.emit('call-full');
      return;
    }

    if (callData.waitingParticipant) {
      console.log(`⏳ Déjà un participant en attente pour l'appel ${callCode}`);
      socket.emit('call-busy');
      return;
    }

    // Stocker le participant en attente
    callData.waitingParticipant = {
      id: socket.id,
      socketId: socket.id,
      joinedAt: new Date().toISOString()
    };

    // Informer uniquement le créateur
    socket.to(callData.callId).emit('participant-waiting', {
      participantId: socket.id,
      callCode: callCode,
      timestamp: new Date().toISOString()
    });

    // Informer le participant qu'il est en attente
    socket.emit('call-waiting-for-approval', {
      callId: callData.callId,
      creatorId: callData.creator,
      callCode: callCode
    });

    console.log(`⏳ Participant ${socket.id} en attente d'approbation pour l'appel ${callCode}`);
  });

  // Accepter un participant
  socket.on('accept-participant', ({ callCode, participantId }) => {
    console.log(`✅ Acceptation du participant ${participantId} pour l'appel ${callCode} par ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    
    // Vérifications
    if (!callData) {
      console.log(`❌ Appel ${callCode} non trouvé pour acceptation`);
      socket.emit('accept-failed', { reason: 'call-not-found' });
      return;
    }

    if (socket.id !== callData.creator) {
      console.log(`❌ Seul le créateur peut accepter les participants`);
      socket.emit('accept-failed', { reason: 'not-creator' });
      return;
    }

    if (!callData.waitingParticipant || callData.waitingParticipant.id !== participantId) {
      console.log(`❌ Aucun participant ${participantId} en attente`);
      socket.emit('accept-failed', { reason: 'no-waiting-participant' });
      return;
    }

    if (callData.participants.length >= 2) {
      console.log(`❌ Appel déjà complet`);
      socket.emit('accept-failed', { reason: 'call-full' });
      return;
    }

    // Ajouter le participant à la liste des participants actifs
    callData.participants.push(participantId);
    
    // Récupérer le socket du participant
    const participantSocket = io.sockets.sockets.get(participantId);
    
    if (participantSocket) {
      // Faire rejoindre la room au participant
      participantSocket.join(callData.callId);
      
      // Informer le participant qu'il a été accepté
      participantSocket.emit('call-joined', {
        callId: callData.callId,
        creatorId: callData.creator,
        participants: callData.participants,
        participantCount: callData.participants.length,
        acceptedBy: socket.id
      });
    }

    // Supprimer le participant en attente
    delete callData.waitingParticipant;

    // Informer TOUS les participants dans la room
    io.to(callData.callId).emit('participant-accepted', {
      participantId: participantId,
      participantCount: callData.participants.length,
      acceptedBy: socket.id
    });

    console.log(`✅ Participant ${participantId} accepté pour l'appel ${callCode}. Total: ${callData.participants.length}`);
  });

  // Refuser un participant
  socket.on('reject-participant', ({ callCode, participantId }) => {
    console.log(`❌ Refus du participant ${participantId} pour l'appel ${callCode} par ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    
    if (!callData || socket.id !== callData.creator) {
      console.log(`❌ Seul le créateur peut refuser les participants`);
      return;
    }

    if (!callData.waitingParticipant || callData.waitingParticipant.id !== participantId) {
      console.log(`❌ Aucun participant ${participantId} en attente`);
      return;
    }

    // Récupérer le socket du participant
    const participantSocket = io.sockets.sockets.get(participantId);
    
    if (participantSocket) {
      // Informer le participant qu'il a été refusé
      participantSocket.emit('call-rejected', {
        callCode: callCode,
        rejectedBy: socket.id
      });
    }

    // Réinitialiser l'attente
    delete callData.waitingParticipant;

    // Informer le créateur
    socket.emit('participant-rejected', { 
      participantId,
      callCode 
    });

    console.log(`❌ Participant ${participantId} refusé pour l'appel ${callCode}`);
  });

  // Envoyer une offre WebRTC - MODIFIÉ
socket.on('send-offer', ({ callCode, offer }) => {
  console.log(`📤 Offre WebRTC reçue pour l'appel ${callCode} de ${socket.id}`);
  
  const callData = activeCalls.get(callCode);
  if (callData && callData.participants.length >= 2) {
    // Trouver l'autre participant
    const otherParticipants = callData.participants.filter(id => id !== socket.id);
    
    if (otherParticipants.length > 0) {
      // Envoyer à tous les autres participants
      otherParticipants.forEach(participantId => {
        const participantSocket = io.sockets.sockets.get(participantId);
        if (participantSocket) {
          participantSocket.emit('receive-offer', { 
            offer, 
            from: socket.id,
            callCode: callCode
          });
          console.log(`📤 Offre transmise à ${participantId}`);
        }
      });
    }
  }
});

// Envoyer une réponse WebRTC - MODIFIÉ
socket.on('send-answer', ({ callCode, answer }) => {
  console.log(`📥 Réponse WebRTC reçue pour l'appel ${callCode} de ${socket.id}`);
  
  const callData = activeCalls.get(callCode);
  if (callData && callData.participants.length >= 2) {
    // Trouver l'autre participant
    const otherParticipants = callData.participants.filter(id => id !== socket.id);
    
    if (otherParticipants.length > 0) {
      // Envoyer à tous les autres participants
      otherParticipants.forEach(participantId => {
        const participantSocket = io.sockets.sockets.get(participantId);
        if (participantSocket) {
          participantSocket.emit('receive-answer', { 
            answer, 
            from: socket.id,
            callCode: callCode
          });
          console.log(`📥 Réponse transmise à ${participantId}`);
        }
      });
    }
  }
});

// Échanger les candidats ICE - MODIFIÉ
socket.on('send-ice-candidate', ({ callCode, candidate }) => {
  const callData = activeCalls.get(callCode);
  if (callData && callData.participants.length >= 2) {
    // Trouver l'autre participant
    const otherParticipants = callData.participants.filter(id => id !== socket.id);
    
    if (otherParticipants.length > 0) {
      // Envoyer à tous les autres participants
      otherParticipants.forEach(participantId => {
        const participantSocket = io.sockets.sockets.get(participantId);
        if (participantSocket) {
          participantSocket.emit('receive-ice-candidate', { 
            candidate, 
            from: socket.id,
            callCode: callCode
          });
        }
      });
    }
  }
});
  // Gérer la sortie volontaire d'un appel
  socket.on('leave-call', ({ callCode }) => {
    console.log(`🚪 Tentative de quitter l'appel ${callCode} par ${socket.id}`);
    
    const callData = activeCalls.get(callCode);
    if (callData) {
      console.log(`ℹ️ Appel trouvé. Participants avant: ${callData.participants.length}`);
      
      // Retirer le participant de la liste
      const wasInCall = callData.participants.includes(socket.id);
      callData.participants = callData.participants.filter(id => id !== socket.id);
      
      // Si c'était un participant en attente, le supprimer aussi
      if (callData.waitingParticipant && callData.waitingParticipant.id === socket.id) {
        delete callData.waitingParticipant;
        console.log(`ℹ️ Participant en attente supprimé`);
      }
      
      console.log(`ℹ️ Participants après: ${callData.participants.length}`);
      
      if (callData.participants.length === 0) {
        // Supprimer l'appel si plus de participants
        activeCalls.delete(callCode);
        console.log(`🗑️ Appel ${callCode} supprimé (plus de participants)`);
      } else if (wasInCall) {
        // Informer les autres participants seulement si c'était un participant actif
        io.to(callData.callId).emit('participant-left', { 
          participantId: socket.id,
          participantCount: callData.participants.length
        });
        console.log(`📤 Notification envoyée aux autres participants`);
      }
      
      // Quitter la room Socket.io
      socket.leave(callData.callId);
    } else {
      console.log(`❌ Appel ${callCode} non trouvé pour leave-call`);
    }
  });

  // Gérer la déconnexion
  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion du socket:', socket.id);
    
    // Nettoyer les appels inactifs
    for (const [callCode, callData] of activeCalls.entries()) {
      let shouldNotify = false;
      
      // Vérifier si c'était un participant actif
      if (callData.participants.includes(socket.id)) {
        console.log(`ℹ️ Retrait de ${socket.id} de l'appel ${callCode}`);
        
        // Retirer le participant de la liste
        callData.participants = callData.participants.filter(id => id !== socket.id);
        shouldNotify = true;
      }
      
      // Vérifier si c'était un participant en attente
      if (callData.waitingParticipant && callData.waitingParticipant.id === socket.id) {
        console.log(`ℹ️ Suppression du participant en attente ${socket.id}`);
        delete callData.waitingParticipant;
      }
      
      if (shouldNotify) {
        if (callData.participants.length === 0) {
          // Supprimer l'appel si plus de participants
          activeCalls.delete(callCode);
          console.log(`🗑️ Appel ${callCode} supprimé (plus de participants après déconnexion)`);
        } else {
          // Informer les autres participants
          io.to(callData.callId).emit('participant-left', { 
            participantId: socket.id,
            participantCount: callData.participants.length
          });
          console.log(`📤 Notification envoyée pour la déconnexion de ${socket.id}`);
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
    timestamp: new Date().toISOString(),
    version: '1.2.0'
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
      waitingParticipant: !!callData.waitingParticipant,
      maxParticipants: 2,
      creator: callData.creator,
      createdAt: callData.createdAt
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
      waitingParticipant: !!data.waitingParticipant,
      creator: data.creator,
      createdAt: data.createdAt,
      callId: data.callId
    });
  }
  res.json({ 
    total: calls.length,
    calls: calls 
  });
});

// Route pour obtenir les détails d'un appel
app.get('/api/call/:callCode', (req, res) => {
  const { callCode } = req.params;
  const callData = activeCalls.get(callCode);
  
  if (callData) {
    res.json({
      success: true,
      call: {
        code: callCode,
        participants: callData.participants,
        waitingParticipant: callData.waitingParticipant,
        creator: callData.creator,
        createdAt: callData.createdAt,
        callId: callData.callId
      }
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'Appel non trouvé'
    });
  }
});

// Route pour nettoyer les appels inactifs
app.post('/api/cleanup', (req, res) => {
  const now = new Date();
  let cleaned = 0;
  
  for (const [code, data] of activeCalls.entries()) {
    const createdAt = new Date(data.createdAt);
    const hoursDiff = (now - createdAt) / (1000 * 60 * 60);
    
    // Supprimer les appels de plus de 24h
    if (hoursDiff > 24) {
      activeCalls.delete(code);
      cleaned++;
    }
  }
  
  res.json({
    success: true,
    cleaned: cleaned,
    remaining: activeCalls.size,
    message: `Nettoyé ${cleaned} appel(s) inactif(s)`
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur backend en écoute sur le port ${PORT}`);
  console.log(`📡 WebSocket prêt à recevoir des connexions`);
  console.log(`🌍 Mode: ${process.env.NODE_ENV || 'development'}`);
});
