// =========================================================
// WEBCAMS.JS — módulo común de videollamada por sala (PeerJS)
// =========================================================
// Requisitos antes de cargar este archivo en una sala:
//   1) Debe existir ya la variable global VIDEO_ROOM (string única por sala).
//   2) Debe existir ya la variable global jugadorActual y la función nombreVisible(id).
//   3) Debe existir en el HTML: <div id="video-grid"></div> y un elemento con id="video-status".
//   4) La librería PeerJS debe estar cargada ANTES que este archivo:
//        <script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>
//        <script src="webcams.js"></script>
//
// Uso típico en cada sala (sustituye TODO el bloque <script> de PeerJS que
// tenías pegado en el HTML):
//
//   <script>
//     const VIDEO_ROOM = "outpost31_sala_cocina"; // <-- cambia esto por sala
//   </script>
//   <script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>
//   <script src="webcams.js"></script>
//
// =========================================================

(function () {
    const HOST_PEER_ID = "thething-2026-" + VIDEO_ROOM + "-host";

    let peer = null;
    let localStream = null;
    let isHost = false;
    let destroyed = false;
    const peerNames = {};
    const dataConnections = new Map();
    const activeCalls = new Map();

    const grid = document.getElementById("video-grid");
    const statusEl = document.getElementById("video-status");
    // Segundo indicador opcional: si la sala tiene un elemento con este id
    // (normalmente bajo el texto "IDENTIDAD:" del HUD), también se actualiza.
    // Si no existe en esta sala, no pasa nada: se ignora silenciosamente.
    const statusHudEl = document.getElementById("video-status-hud");

    // Estilos para el indicador de "solo audio" (jugador sin cámara).
    // Se inyectan aquí para no tener que tocar el <style> de cada sala.
    const estiloAudio = document.createElement("style");
    estiloAudio.textContent = `
        .video-audio-icon{
            display:none;
            position:absolute;
            inset:0;
            align-items:center;
            justify-content:center;
            font-size:2rem;
            color:#00f0ff;
            background:#03060c;
        }
        .video-card.audio-only .video-audio-icon{ display:flex; }
        .video-card.audio-only video{ display:none; }
    `;
    document.head.appendChild(estiloAudio);

    function setVideoStatus(text, good = false) {
        const color = good ? "#5cdb95" : "#5a7d9b";
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }
        if (statusHudEl) {
            statusHudEl.textContent = text;
            statusHudEl.style.color = color;
        }
    }

    function addVideoCard(id, name, stream, isLocal = false, soloAudioForzado = false) {
        let card = document.getElementById("video-card-" + id);
        if (!card) {
            card = document.createElement("div");
            card.className = "video-card";
            card.id = "video-card-" + id;
            card.innerHTML = '<video autoplay playsinline></video><div class="video-name"></div><div class="video-audio-icon">🎤</div>';
            grid.appendChild(card);
        }
        const video = card.querySelector("video");
        card.querySelector(".video-name").textContent = name || "Jugador";
        video.muted = isLocal;
        if (stream && video.srcObject !== stream) video.srcObject = stream;

        // Si el stream no trae pista de vídeo (jugador sin cámara), lo marcamos
        // como "solo audio" para que la tarjeta muestre el icono de micro en vez
        // de un recuadro negro vacío.
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
        setVideoStatus(`Conectados (${count})`, true);
    }

    function broadcast(message) {
        for (const conn of dataConnections.values()) {
            if (conn.open) { try { conn.send(message); } catch (_) {} }
        }
    }

    function callPeer(id, name) {
        if (!peer || peer.destroyed || !localStream || id === peer.id || activeCalls.has(id)) return;
        const call = peer.call(id, localStream, {
            metadata: { name: nombreVisible(jugadorActual), room: VIDEO_ROOM }
        });
        activeCalls.set(id, call);

        call.on("stream", stream => {
            addVideoCard(id, name || peerNames[id] || "Jugador", stream, false);
        });
        call.on("close", () => { activeCalls.delete(id); removeVideoCard(id); });
        call.on("error", () => { activeCalls.delete(id); removeVideoCard(id); });
    }

    function connectToPeer(id) {
        if (!peer || peer.destroyed || !id || id === peer.id || dataConnections.has(id)) return;
        const conn = peer.connect(id, {
            reliable: true,
            metadata: { name: nombreVisible(jugadorActual), room: VIDEO_ROOM }
        });
        installDataConnection(conn);

        // Si esta conexión concreta no llega a abrirse en unos segundos
        // (red, NAT, wifi restrictivo...), la descartamos para que el
        // heartbeat pueda reintentarla más adelante en vez de quedar
        // "atascada" para siempre bloqueando el reintento.
        setTimeout(() => {
            if (!conn.open && dataConnections.get(id) === conn) {
                try { conn.close(); } catch (_) {}
                dataConnections.delete(id);
            }
        }, 10000);
    }

    function installDataConnection(conn) {
        const id = conn.peer;
        dataConnections.set(id, conn);

        conn.on("open", () => {
            if (!isHost && id !== HOST_PEER_ID) {
                callPeer(id, peerNames[id] || "Jugador");
            }
            if (isHost) {
                const players = Object.entries(peerNames).map(([peerId, name]) => ({ peerId, name }));
                if (!players.some(p => p.peerId === peer.id)) {
                    players.push({ peerId: peer.id, name: nombreVisible(jugadorActual) });
                }
                conn.send({ type: "roster", players });
                callPeer(id, peerNames[id] || "Jugador");
            }
        });

        conn.on("data", message => {
            if (!message || typeof message !== "object") return;
            if (message.type === "roster") {
                (message.players || []).forEach(player => {
                    if (!player || !player.peerId || player.peerId === peer.id) return;
                    peerNames[player.peerId] = player.name || "Jugador";
                    connectToPeer(player.peerId);
                });
            }
            if (message.type === "player-joined") {
                const player = message.player;
                if (!player || !player.peerId || player.peerId === peer.id) return;
                peerNames[player.peerId] = player.name || "Jugador";
                connectToPeer(player.peerId);
            }
            if (message.type === "player-left") {
                if (!message.peerId) return;
                removeVideoCard(message.peerId);
                dataConnections.delete(message.peerId);
                activeCalls.delete(message.peerId);
                delete peerNames[message.peerId];
            }
        });

        conn.on("close", () => { dataConnections.delete(id); removeVideoCard(id); });
        conn.on("error", () => { dataConnections.delete(id); removeVideoCard(id); });
    }

    function acceptCall(call) {
        const callerId = call.peer;
        const callerName = (call.metadata && call.metadata.name) || peerNames[callerId] || "Jugador";
        call.answer(localStream);
        activeCalls.set(callerId, call);

        call.on("stream", stream => {
            peerNames[callerId] = callerName;
            addVideoCard(callerId, callerName, stream, false);
        });
        call.on("close", () => { activeCalls.delete(callerId); removeVideoCard(callerId); });
        call.on("error", () => { activeCalls.delete(callerId); removeVideoCard(callerId); });
    }

    async function startMedia() {
        let soloAudio = false;
        try {
            // Intento normal: cámara + micro
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (errorConCamara) {
            // Sin cámara, cámara ocupada por otra app, o permiso de vídeo denegado:
            // reintentamos solo con audio en vez de dejar al jugador fuera de la llamada.
            localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            soloAudio = true;
        }
        addVideoCard("local", nombreVisible(jugadorActual) + " (TÚ)", localStream, true, soloAudio);
        if (soloAudio) setVideoStatus("Conectado solo con audio", true);

        // AVISO si al usuario se le corta la cámara o el micro en pleno directo
        // (permiso revocado, dispositivo desconectado, pestaña dormida, etc.)
        localStream.getTracks().forEach(track => {
            track.addEventListener("ended", () => {
                setVideoStatus("Cámara/micro cortados", false);
            });
        });
    }

    function createPeer() {
        const options = { host: "0.peerjs.com", port: 443, path: "/", secure: true, debug: 1 };
        peer = isHost ? new Peer(HOST_PEER_ID, options) : new Peer(options);

        peer.on("open", id => {
            if (isHost) {
                peerNames[id] = nombreVisible(jugadorActual);
                setVideoStatus("Sala activa", true);
            } else {
                setVideoStatus("Conectando a sala...");
                connectToPeer(HOST_PEER_ID);
            }
        });

        peer.on("connection", conn => {
            if (isHost) {
                const name = (conn.metadata && conn.metadata.name) || "Jugador";
                peerNames[conn.peer] = name;
                installDataConnection(conn);
                broadcast({ type: "player-joined", player: { peerId: conn.peer, name } });
            } else {
                installDataConnection(conn);
            }
        });

        peer.on("call", acceptCall);

        peer.on("error", err => {
            if (err.type === "unavailable-id" && isHost) {
                isHost = false;
                try { peer.destroy(); } catch (_) {}
                peer = null;
                setTimeout(createPeer, 250);
                return;
            }
            if (err.type === "peer-unavailable" && !isHost) {
                setVideoStatus("Esperando tripulantes...");
                setTimeout(() => {
                    if (!destroyed && peer && !peer.destroyed) connectToPeer(HOST_PEER_ID);
                }, 1500);
                return;
            }
            setVideoStatus("Error de enlace");
        });
    }

    async function iniciarVideollamada() {
        try {
            await startMedia();
        } catch (error) {
            // Llega aquí solo si tampoco hay micrófono disponible/permitido,
            // porque startMedia() ya intenta el audio solo como último recurso.
            setVideoStatus("Sin cámara ni micrófono");
            return;
        }
        isHost = true;
        createPeer();
    }

    function salirDeLaLlamada(navigate = true) {
        destroyed = true;
        try { broadcast({ type: "player-left", peerId: peer ? peer.id : null }); } catch (_) {}
        activeCalls.forEach(call => { try { call.close(); } catch (_) {} });
        dataConnections.forEach(conn => { try { conn.close(); } catch (_) {} });
        activeCalls.clear();
        dataConnections.clear();
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        if (peer) {
            try { peer.destroy(); } catch (_) {}
            peer = null;
        }
    }

    // -----------------------------------------------------
    // === ARREGLO 1: HEARTBEAT DE RECONEXIÓN CON EL HOST ===
    // Si no soy el host y no tengo conexión abierta con el host,
    // lo reintento cada 5s. Esto es lo que faltaba: antes, si el
    // host se iba y volvía (o cambiaba), los que ya estaban en la
    // sala se quedaban "sordos" para siempre, porque nada volvía
    // a llamar a la puerta del host una vez cerrada la conexión.
    // -----------------------------------------------------
    setInterval(() => {
        if (destroyed || isHost) return;
        if (!peer || peer.destroyed) return;
        if (!dataConnections.has(HOST_PEER_ID)) {
            connectToPeer(HOST_PEER_ID);
        }
    }, 5000);

    // -----------------------------------------------------
    // === ARREGLO 2: HEARTBEAT DE RECONEXIÓN CON CADA JUGADOR ===
    // Las llamadas de vídeo van directas entre jugadores, no a
    // través del host. Si una de esas conexiones directas se queda
    // a medias (nunca llega a abrirse ni a dar error, por red/NAT),
    // antes se quedaba bloqueada para siempre. Ahora, cada 6s,
    // repasamos a todos los jugadores que conocemos (peerNames) y
    // reintentamos con cualquiera que no esté realmente conectado.
    // -----------------------------------------------------
    setInterval(() => {
        if (destroyed || !peer || peer.destroyed) return;
        Object.keys(peerNames).forEach(id => {
            if (id === peer.id) return;
            const conn = dataConnections.get(id);
            if (!conn || !conn.open) {
                if (conn) dataConnections.delete(id);
                connectToPeer(id);
            }
        });
    }, 6000);

    window.addEventListener("beforeunload", () => salirDeLaLlamada(false));
    window.addEventListener("pagehide", () => salirDeLaLlamada(false));

    // Expone estas dos funciones globalmente porque el resto del HTML
    // de la sala (botones de puerta, etc.) las llama directamente.
    window.salirDeLaLlamada = salirDeLaLlamada;
    window.iniciarVideollamada = iniciarVideollamada;

    iniciarVideollamada();
})();
