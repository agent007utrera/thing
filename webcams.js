// =========================================================
// WEBCAMS.JS — estable: ver a todos, sin cortes por errores
// =========================================================
// Principios:
//   - Roster pedido al host cada ~8 s (aunque ya veas gente)
//   - Reinicio suave SOLO si llevas ~14 s realmente solo
//   - Errores: reintentar enlace, NO destruir peer ni tarjetas activas
//   - Llamadas fantasma sin vídeo se reintentan sin cortar el resto
// =========================================================

(function () {
    const HOST_PEER_ID = "thething-2026-" + VIDEO_ROOM + "-host";

    let peer = null;
    let localStream = null;
    let isHost = false;
    let destroyed = false;
    let lastHostContact = Date.now();
    let lastFailoverAttempt = 0;
    let roomStartTime = Date.now();
    let lastRosterRequest = 0;
    let aloneSince = null;
    let lastSoftRecovery = 0;
    const peerNames = {};
    const dataConnections = new Map();
    const activeCalls = new Map();
    const lastSeen = new Map();

    const GRACE_PERIOD_MS = 18000;
    const PEER_TIMEOUT_MS = 30000;
    const HOST_UNREACHABLE_MS = 16000;
    const FAILOVER_COOLDOWN_MS = 20000;
    const INITIAL_CONNECT_MSG_MS = 8000;
    const ROSTER_REQUEST_INTERVAL_MS = 8000;
    const SOLO_RECOVERY_MS = 16000;
    const SOLO_RECOVERY_COOLDOWN_MS = 30000;

    const grid = document.getElementById("video-grid");
    const statusEl = document.getElementById("video-status");
    const statusHudEl = document.getElementById("video-status-hud");

    const estiloAudio = document.createElement("style");
    estiloAudio.textContent = `
        .video-audio-icon{
            display:none; position:absolute; inset:0;
            align-items:center; justify-content:center;
            font-size:2rem; color:#00f0ff; background:#03060c;
        }
        .video-card.audio-only .video-audio-icon{ display:flex; }
        .video-card.audio-only video{ display:none; }
    `;
    document.head.appendChild(estiloAudio);

    function getMyDisplayName() {
        if (typeof nombreVisible === "function" &&
            typeof jugadorActual !== "undefined" &&
            jugadorActual &&
            jugadorActual !== "JUGADOR" &&
            jugadorActual !== "jugadorXXXX") {
            return nombreVisible(jugadorActual);
        }
        const savedId = localStorage.getItem("jugador_activo_global");
        if (savedId && typeof nombreVisible === "function") {
            const n = nombreVisible(savedId);
            if (n && n !== "JUGADOR" && n !== savedId.toUpperCase()) return n;
        }
        const savedName = localStorage.getItem("jugador_nombre_real");
        if (savedName &&
            savedName !== "JUGADOR" &&
            savedName !== "jugadorXXXX" &&
            !savedName.startsWith("jugador")) {
            return savedName.toUpperCase();
        }
        return "Jugador";
    }

    function setVideoStatus(text, good = false) {
        const color = good ? "#5cdb95" : "#5a7d9b";
        if (statusEl) { statusEl.textContent = text; statusEl.style.color = color; }
        if (statusHudEl) { statusHudEl.textContent = text; statusHudEl.style.color = color; }
    }

    function updateCardName(id, name) {
        const card = document.getElementById("video-card-" + id);
        if (card) {
            const nameEl = card.querySelector(".video-name");
            if (nameEl && name && name !== "Jugador" && name !== "JUGADOR") {
                nameEl.textContent = name;
            }
        }
    }

    function setPeerName(id, name) {
        if (!id || !name) return;
        const clean = String(name).trim();
        if (!clean || clean === "Jugador" || clean === "JUGADOR") return;
        peerNames[id] = clean;
        updateCardName(id, clean);
    }

    function addVideoCard(id, name, stream, isLocal = false, soloAudioForzado = false) {
        if (!grid) return;
        let card = document.getElementById("video-card-" + id);
        if (!card) {
            card = document.createElement("div");
            card.className = "video-card";
            card.id = "video-card-" + id;
            card.innerHTML = '<video autoplay playsinline></video><div class="video-name"></div><div class="video-audio-icon">🎤</div>';
            grid.appendChild(card);
        }
        const video = card.querySelector("video");
        const finalName = (name && name !== "Jugador" && name !== "JUGADOR")
            ? name
            : (peerNames[id] || name || "Jugador");
        card.querySelector(".video-name").textContent = finalName;
        video.muted = isLocal;
        if (stream && video.srcObject !== stream) video.srcObject = stream;

        const sinVideo = soloAudioForzado || !stream || stream.getVideoTracks().length === 0;
        card.classList.toggle("audio-only", sinVideo);
        updatePlayerCount();
    }

    function removeVideoCard(id) {
        const card = document.getElementById("video-card-" + id);
        if (card) card.remove();
        updatePlayerCount();
    }

    function updatePlayerCount() {
        const count = document.querySelectorAll(".video-card").length;
        const elapsed = Date.now() - roomStartTime;
        if (elapsed < INITIAL_CONNECT_MSG_MS && count <= 1) {
            setVideoStatus("Conectando con tripulantes...", false);
        } else {
            setVideoStatus("Conectados (" + count + ")", true);
        }
    }

    function broadcast(message) {
        for (const conn of dataConnections.values()) {
            if (conn.open) {
                try { conn.send(message); } catch (_) {}
            }
        }
    }

    function buildRosterPayload() {
        const players = Object.entries(peerNames).map(([peerId, name]) => ({ peerId, name }));
        if (peer && peer.id && !players.some(p => p.peerId === peer.id)) {
            players.push({ peerId: peer.id, name: getMyDisplayName() });
        }
        return { type: "roster", players };
    }

    function sendRosterTo(conn) {
        if (!conn || !conn.open) return;
        try { conn.send(buildRosterPayload()); } catch (_) {}
    }

    function callPeer(id, name) {
        if (!peer || peer.destroyed || !localStream || id === peer.id) return;

        // Solo reintentar si no hay tarjeta de vídeo (llamada fantasma)
        if (activeCalls.has(id)) {
            if (document.getElementById("video-card-" + id)) return;
            try { activeCalls.get(id).close(); } catch (_) {}
            activeCalls.delete(id);
        }

        let call;
        try {
            call = peer.call(id, localStream, {
                metadata: { name: getMyDisplayName(), room: VIDEO_ROOM }
            });
        } catch (_) {
            return;
        }
        if (!call) return;
        activeCalls.set(id, call);

        call.on("stream", stream => {
            lastSeen.set(id, Date.now());
            addVideoCard(id, peerNames[id] || name || "Jugador", stream, false);
        });
        call.on("close", () => {
            activeCalls.delete(id);
            // No quitar tarjeta al instante: puede reabrirse; sweep/left lo limpia
        });
        call.on("error", () => {
            activeCalls.delete(id);
        });
    }

    function ensureCallsToAll() {
        if (!peer || peer.destroyed) return;
        Object.keys(peerNames).forEach(id => {
            if (id === peer.id) return;
            const conn = dataConnections.get(id);
            if (!conn || !conn.open) {
                if (conn) dataConnections.delete(id);
                connectToPeer(id);
            }
            if (!document.getElementById("video-card-" + id)) {
                callPeer(id, peerNames[id]);
            }
        });
    }

    function connectToPeer(id) {
        if (!peer || peer.destroyed || !id || id === peer.id || dataConnections.has(id)) return;

        let conn;
        try {
            conn = peer.connect(id, {
                reliable: true,
                metadata: { name: getMyDisplayName(), room: VIDEO_ROOM }
            });
        } catch (_) {
            return;
        }
        if (!conn) return;
        installDataConnection(conn);

        setTimeout(() => {
            if (!conn.open && dataConnections.get(id) === conn) {
                try { conn.close(); } catch (_) {}
                dataConnections.delete(id);
            }
        }, 12000);
    }

    function installDataConnection(conn) {
        const id = conn.peer;
        dataConnections.set(id, conn);

        conn.on("open", () => {
            lastSeen.set(id, Date.now());
            if (id === HOST_PEER_ID) lastHostContact = Date.now();

            if (isHost) {
                sendRosterTo(conn);
                callPeer(id, peerNames[id] || "Jugador");
            } else {
                try { conn.send({ type: "request-roster" }); } catch (_) {}
                lastRosterRequest = Date.now();
                callPeer(id, peerNames[id] || "Jugador");
            }
        });

        conn.on("data", message => {
            if (!message || typeof message !== "object") return;
            lastSeen.set(id, Date.now());
            if (id === HOST_PEER_ID) lastHostContact = Date.now();

            if (message.type === "ping-peer") {
                try { conn.send({ type: "pong-peer" }); } catch (_) {}
            }

            if (message.type === "request-roster" && isHost) {
                sendRosterTo(conn);
            }

            if (message.type === "roster") {
                (message.players || []).forEach(player => {
                    if (!player || !player.peerId || player.peerId === peer.id) return;
                    setPeerName(player.peerId, player.name);
                    connectToPeer(player.peerId);
                });
                ensureCallsToAll();
            }

            if (message.type === "player-joined") {
                const player = message.player;
                if (!player || !player.peerId || player.peerId === peer.id) return;
                setPeerName(player.peerId, player.name);
                connectToPeer(player.peerId);
                ensureCallsToAll();
            }

            if (message.type === "player-left") {
                if (!message.peerId) return;
                delete peerNames[message.peerId];
                removeVideoCard(message.peerId);
                const c = dataConnections.get(message.peerId);
                if (c) { try { c.close(); } catch (_) {} }
                dataConnections.delete(message.peerId);
                const call = activeCalls.get(message.peerId);
                if (call) { try { call.close(); } catch (_) {} }
                activeCalls.delete(message.peerId);
            }

            if (message.type === "name-update") {
                if (message.peerId && message.name) {
                    setPeerName(message.peerId, message.name);
                }
            }
        });

        conn.on("close", () => {
            dataConnections.delete(id);
            if (id === HOST_PEER_ID) lastHostContact = 0;
            // No quitar vídeo aquí: el stream puede seguir; sweep o player-left limpian
        });
        conn.on("error", () => {
            dataConnections.delete(id);
        });
    }

    function acceptCall(call) {
        const callerId = call.peer;
        const callerName = (call.metadata && call.metadata.name) || peerNames[callerId] || "Jugador";
        if (!localStream) return;
        try { call.answer(localStream); } catch (_) { return; }
        activeCalls.set(callerId, call);
        setPeerName(callerId, callerName);

        call.on("stream", stream => {
            lastSeen.set(callerId, Date.now());
            addVideoCard(callerId, peerNames[callerId] || callerName, stream, false);
        });
        call.on("close", () => { activeCalls.delete(callerId); });
        call.on("error", () => { activeCalls.delete(callerId); });
    }

    async function startMedia() {
        if (localStream && localStream.getTracks().some(t => t.readyState === "live")) {
            addVideoCard("local", getMyDisplayName() + " (TÚ)", localStream, true, localStream.getVideoTracks().length === 0);
            return;
        }

        let soloAudio = false;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (e) {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
                soloAudio = true;
            } catch (e2) {
                throw e2;
            }
        }
        addVideoCard("local", getMyDisplayName() + " (TÚ)", localStream, true, soloAudio);
        if (soloAudio) setVideoStatus("Conectado solo con audio", true);

        localStream.getTracks().forEach(track => {
            track.addEventListener("ended", () => setVideoStatus("Cámara/micro cortados", false));
        });
    }

    function createPeer(forceHost = false) {
        if (destroyed) return;

        const options = { host: "0.peerjs.com", port: 443, path: "/", secure: true, debug: 0 };

        if (forceHost || isHost) {
            peer = new Peer(HOST_PEER_ID, options);
            isHost = true;
        } else {
            peer = new Peer(options);
            isHost = false;
        }

        peer.on("open", id => {
            if (isHost) {
                setPeerName(id, getMyDisplayName());
                const elapsed = Date.now() - roomStartTime;
                if (elapsed < INITIAL_CONNECT_MSG_MS) {
                    setVideoStatus("Conectando con tripulantes...", false);
                } else {
                    setVideoStatus("Sala activa", true);
                }
                startHostBroadcast();
            } else {
                setVideoStatus("Conectando con tripulantes...", false);
                connectToPeer(HOST_PEER_ID);
            }

            setTimeout(() => {
                const myName = getMyDisplayName();
                if (myName && myName !== "Jugador" && peer && peer.id) {
                    broadcast({ type: "name-update", peerId: peer.id, name: myName });
                    updateCardName("local", myName + " (TÚ)");
                }
            }, 1800);
        });

        peer.on("connection", conn => {
            if (isHost) {
                const name = (conn.metadata && conn.metadata.name) || "Jugador";
                setPeerName(conn.peer, name);
                installDataConnection(conn);
                broadcast({ type: "player-joined", player: { peerId: conn.peer, name } });
            } else {
                installDataConnection(conn);
            }
        });

        peer.on("call", acceptCall);

        // Errores: reintentar sin destruir la sala ni las webcams que ya funcionan
        peer.on("error", err => {
            if (destroyed) return;

            if (err.type === "unavailable-id") {
                isHost = false;
                try { peer.destroy(); } catch (_) {}
                peer = null;
                setTimeout(() => { if (!destroyed) createPeer(false); }, 500);
                return;
            }

            if (err.type === "peer-unavailable") {
                if (!isHost) {
                    setVideoStatus("Esperando tripulantes...");
                    setTimeout(() => {
                        if (!destroyed && peer && !peer.destroyed) connectToPeer(HOST_PEER_ID);
                    }, 2000);
                }
                return;
            }

            // Otros errores: mensaje suave + reintentos ligeros (NO softRecover)
            setVideoStatus("Reintentando enlace...");
            setTimeout(() => {
                if (destroyed || !peer || peer.destroyed) return;
                if (!isHost) connectToPeer(HOST_PEER_ID);
                ensureCallsToAll();
                updatePlayerCount();
            }, 2000);
        });

        peer.on("disconnected", () => {
            if (destroyed) return;
            setVideoStatus("Reconectando señal...");
            try {
                if (peer && !peer.destroyed && typeof peer.reconnect === "function") {
                    peer.reconnect();
                }
            } catch (_) {}
        });
    }

    let hostBroadcastInterval = null;
    function startHostBroadcast() {
        if (hostBroadcastInterval) clearInterval(hostBroadcastInterval);
        hostBroadcastInterval = setInterval(() => {
            if (!isHost || destroyed) return;
            broadcast(buildRosterPayload());
            broadcast({ type: "ping" });
        }, 6000);
    }

    function sendPeerPings() {
        if (destroyed) return;
        broadcast({ type: "ping-peer" });
    }

    function sweepDeadPeers() {
        if (destroyed) return;
        if (Date.now() - roomStartTime < GRACE_PERIOD_MS) return;

        const now = Date.now();
        for (const id of Array.from(dataConnections.keys())) {
            const visto = lastSeen.get(id) || 0;
            if (now - visto > PEER_TIMEOUT_MS) {
                const conn = dataConnections.get(id);
                if (conn) { try { conn.close(); } catch (_) {} }
                dataConnections.delete(id);
                const call = activeCalls.get(id);
                if (call) { try { call.close(); } catch (_) {} }
                activeCalls.delete(id);
                lastSeen.delete(id);
                delete peerNames[id];
                removeVideoCard(id);
                if (isHost) broadcast({ type: "player-left", peerId: id });
            }
        }
    }

    function maybeRequestRoster() {
        if (isHost || destroyed) return;
        const hostConn = dataConnections.get(HOST_PEER_ID);
        if (!hostConn || !hostConn.open) return;
        if (Date.now() - lastRosterRequest < ROSTER_REQUEST_INTERVAL_MS) return;
        try {
            hostConn.send({ type: "request-roster" });
            lastRosterRequest = Date.now();
        } catch (_) {}
    }

    // Único reinicio fuerte: solo si estás realmente solo mucho rato
    function softRecoverWebcams() {
        if (destroyed) return;
        if (Date.now() - lastSoftRecovery < SOLO_RECOVERY_COOLDOWN_MS) return;

        console.log("[webcams] Solo demasiado tiempo → reinicio suave");
        lastSoftRecovery = Date.now();
        aloneSince = null;
        setVideoStatus("Reconectando...", false);

        if (hostBroadcastInterval) {
            clearInterval(hostBroadcastInterval);
            hostBroadcastInterval = null;
        }

        try {
            broadcast({ type: "player-left", peerId: peer ? peer.id : null });
        } catch (_) {}

        activeCalls.forEach(call => { try { call.close(); } catch (_) {} });
        dataConnections.forEach(conn => { try { conn.close(); } catch (_) {} });
        activeCalls.clear();
        dataConnections.clear();
        lastSeen.clear();
        for (const k of Object.keys(peerNames)) delete peerNames[k];

        document.querySelectorAll(".video-card").forEach(card => {
            if (card.id !== "video-card-local") card.remove();
        });

        if (peer) {
            try { peer.destroy(); } catch (_) {}
            peer = null;
        }

        isHost = true;
        roomStartTime = Date.now();
        lastHostContact = Date.now();

        setTimeout(() => {
            if (!destroyed) createPeer(true);
        }, 700);
    }

    function trackAloneState() {
        const count = document.querySelectorAll(".video-card").length;
        if (count > 1) {
            aloneSince = null;
            return;
        }
        if (Date.now() - roomStartTime < GRACE_PERIOD_MS) {
            aloneSince = null;
            return;
        }
        if (aloneSince === null) {
            aloneSince = Date.now();
            return;
        }
        if (Date.now() - aloneSince >= SOLO_RECOVERY_MS) {
            softRecoverWebcams();
        }
    }

    setInterval(() => {
        if (destroyed) return;

        const enGracia = (Date.now() - roomStartTime) < GRACE_PERIOD_MS;

        if (!isHost) {
            if (!dataConnections.has(HOST_PEER_ID) || !dataConnections.get(HOST_PEER_ID).open) {
                connectToPeer(HOST_PEER_ID);
            }
            maybeRequestRoster();

            if (!enGracia) {
                const estoyAislado = dataConnections.size === 0;
                const haceMuchoQueNoHayHost = Date.now() - lastHostContact > HOST_UNREACHABLE_MS;
                const puedoReintentar = Date.now() - lastFailoverAttempt > FAILOVER_COOLDOWN_MS;

                if (estoyAislado && haceMuchoQueNoHayHost && puedoReintentar && localStream) {
                    lastFailoverAttempt = Date.now();
                    const espera = 400 + Math.floor(Math.random() * 1600);
                    setTimeout(() => {
                        if (destroyed || isHost || dataConnections.size > 0) return;
                        setVideoStatus("Reclamando host...");
                        isHost = true;
                        try { if (peer) peer.destroy(); } catch (_) {}
                        peer = null;
                        dataConnections.clear();
                        activeCalls.clear();
                        createPeer(true);
                    }, espera);
                }
            }
        }

        sendPeerPings();
        sweepDeadPeers();
        ensureCallsToAll();
        trackAloneState();
        updatePlayerCount();
    }, 4000);

    async function iniciarVideollamada() {
        roomStartTime = Date.now();
        aloneSince = null;
        setVideoStatus("Conectando con tripulantes...", false);

        try {
            await startMedia();
        } catch (e) {
            setVideoStatus("Sin cámara ni micrófono");
            return;
        }
        isHost = true;
        createPeer(true);
    }

    function salirDeLaLlamada(navigate = true) {
        destroyed = true;
        if (hostBroadcastInterval) clearInterval(hostBroadcastInterval);

        try {
            broadcast({ type: "player-left", peerId: peer ? peer.id : null });
        } catch (_) {}

        activeCalls.forEach(call => { try { call.close(); } catch (_) {} });
        dataConnections.forEach(conn => { try { conn.close(); } catch (_) {} });
        activeCalls.clear();
        dataConnections.clear();

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        if (peer) {
            try { peer.destroy(); } catch (_) {}
            peer = null;
        }
    }

    window.addEventListener("beforeunload", () => salirDeLaLlamada(false));
    window.addEventListener("pagehide", () => salirDeLaLlamada(false));

    window.salirDeLaLlamada = salirDeLaLlamada;
    window.iniciarVideollamada = iniciarVideollamada;

    iniciarVideollamada();
})();
