// =========================================================
// WEBCAMS.JS — versión con PRESENCIA EN FIREBASE (sin host, sin "cotilleo")
// =========================================================
// Requisitos antes de cargar este archivo en una sala:
//   1) Debe existir ya la variable global VIDEO_ROOM (string única por sala).
//   2) Debe existir ya la variable global jugadorActual y la función nombreVisible(id).
//   3) Debe existir en el HTML: <div id="video-grid"></div> y, opcionalmente,
//      #video-status / #video-status-hud.
//   4) ANTES de este archivo hay que cargar, en este orden:
//        <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
//        <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
//        <script>
//          firebase.initializeApp({ ...tu configuración de Firebase... });
//        </script>
//        <script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>
//        <script src="webcams.js"></script>
//
// CÓMO FUNCIONA (para que quede claro qué cambia respecto a antes)
// -------------------------------------------------------
// Ya no hay "host" ni elección de host, ni roster que se reparte entre
// jugadores, ni pings periódicos entre ellos. En su lugar:
//
//   - Cada jugador, al entrar, escribe UNA vez en Firebase "estoy en esta
//     sala" (bajo rooms/<VIDEO_ROOM>/<miPeerId>).
//   - Firebase, con onDisconnect(), borra esa entrada automáticamente y de
//     forma fiable en el instante en que el jugador cierra la pestaña, pierde
//     la conexión o se le cae el wifi — sin que nadie tenga que preguntar
//     "¿sigues ahí?" cada pocos segundos.
//   - Cada jugador simplemente escucha esa lista de la sala. Cuando aparece
//     alguien nuevo, se conecta a él UNA vez. Cuando desaparece, se cuelga
//     UNA vez. No hay bucles reconectando cosas que ya funcionan.
//   - Para no llamarse dos veces a la vez cuando dos jugadores entran casi
//     a la vez, se usa una norma simple: entre dos jugadores, el que tiene
//     el identificador "mayor" alfabéticamente es quien llama; el otro
//     espera la llamada. Así nunca hay dos llamadas cruzándose.
//   - Si una llamada concreta falla de verdad (no porque el jugador se haya
//     ido — Firebase ya nos lo diría — sino por un corte de red puntual),
//     se reintenta esa llamada en concreto, con un pequeño margen de espera,
//     en vez de repasar a todo el mundo constantemente.
// =========================================================

(function () {
    let peer = null;
    let localStream = null;
    let destroyed = false;
let micActivo = true;
let camActiva = true;

    let db = null;
    let roomRef = null;
    let myPresenceRef = null;

    const peerNames = {};              // peerId -> nombre visible
    const activeCalls = new Map();     // peerId -> MediaConnection
    const retryCount = new Map();      // peerId -> nº de reintentos tras fallo real

    const MAX_RETRIES = 5;
    const RETRY_BASE_DELAY_MS = 2000;

    const grid = document.getElementById("video-grid");
    const statusEl = document.getElementById("video-status");
    const statusHudEl = document.getElementById("video-status-hud");

    // Estilos para el indicador de "solo audio" (jugador sin cámara).
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

    // ---------- nombre fiable del jugador ----------
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
        setVideoStatus(`Conectados (${count})`, true);
    }

    // ---------- llamadas de vídeo (PeerJS) ----------
    function shouldICall(otherId) {
        // Norma simple y determinista para que solo uno de los dos llame:
        // el de id "mayor" alfabéticamente inicia la llamada.
        return peer.id > otherId;
    }

    function callPeer(id) {
        if (!peer || peer.destroyed || !localStream || id === peer.id || activeCalls.has(id)) return;

        const call = peer.call(id, localStream, {
            metadata: { name: getMyDisplayName(), room: VIDEO_ROOM }
        });
        activeCalls.set(id, call);
        wireUpCall(call, id);
    }

    function wireUpCall(call, id) {
        call.on("stream", stream => {
            retryCount.set(id, 0); // llamada OK: reseteamos los reintentos
            addVideoCard(id, peerNames[id] || "Jugador", stream, false);
        });

        const onEnded = () => {
            activeCalls.delete(id);
            removeVideoCard(id);
            // Solo reintentamos si el jugador SIGUE en la sala según Firebase
            // (si se fue de verdad, el listener de presencia ya se encarga).
            if (destroyed || !peerNames.hasOwnProperty(id)) return;
            if (!shouldICall(id)) return; // el otro lado es quien reintenta

            const intentos = (retryCount.get(id) || 0) + 1;
            retryCount.set(id, intentos);
            if (intentos > MAX_RETRIES) return;

            const espera = RETRY_BASE_DELAY_MS * intentos;
            setTimeout(() => {
                if (destroyed || !peerNames.hasOwnProperty(id) || activeCalls.has(id)) return;
                callPeer(id);
            }, espera);
        };

        call.on("close", onEnded);
        call.on("error", onEnded);
    }

    function acceptCall(call) {
        const callerId = call.peer;
        const callerName = (call.metadata && call.metadata.name) || peerNames[callerId] || "Jugador";
        peerNames[callerId] = callerName;

        call.answer(localStream);
        activeCalls.set(callerId, call);
        wireUpCall(call, callerId);
    }

    // ---------- eventos de presencia (Firebase) ----------
    function handlePeerJoined(id, data) {
        if (!peer || id === peer.id) return;
        peerNames[id] = (data && data.name) || "Jugador";
        retryCount.set(id, 0);
        if (shouldICall(id)) callPeer(id);
        // Si no me toca llamar, simplemente espero su llamada (peer.on("call")).
    }

    function handlePeerChanged(id, data) {
        if (!peer || id === peer.id) return;
        const name = (data && data.name) || "Jugador";
        peerNames[id] = name;
        updateCardName(id, name);
    }

    function handlePeerLeft(id) {
        if (!peer || id === peer.id) return;
        delete peerNames[id];
        retryCount.delete(id);
        const call = activeCalls.get(id);
        if (call) { try { call.close(); } catch (_) {} }
        activeCalls.delete(id);
        removeVideoCard(id);
    }

    function setupPresence() {
        db = firebase.database();
        roomRef = db.ref("rooms/" + VIDEO_ROOM);
        myPresenceRef = db.ref("rooms/" + VIDEO_ROOM + "/" + peer.id);

        // Patrón recomendado por Firebase: cada vez que se restablece la
        // conexión con el servidor, se vuelve a registrar el onDisconnect
        // ANTES de escribir la presencia, para que quede protegida también
        // tras un corte y reconexión (no solo la primera vez).
        db.ref(".info/connected").on("value", snap => {
            if (snap.val() !== true) return;
            myPresenceRef.onDisconnect().remove().then(() => {
                myPresenceRef.set({
                    name: getMyDisplayName(),
                    ts: firebase.database.ServerValue.TIMESTAMP
                });
            });
        });

        roomRef.on("child_added", snap => handlePeerJoined(snap.key, snap.val()));
        roomRef.on("child_changed", snap => handlePeerChanged(snap.key, snap.val()));
        roomRef.on("child_removed", snap => handlePeerLeft(snap.key));

        setVideoStatus("Sala activa", true);

        // Si el nombre del jugador se resuelve un poco después de entrar
        // (identidad cargada de forma asíncrona), lo actualizamos una vez.
        setTimeout(() => {
            const myName = getMyDisplayName();
            if (myName && myName !== "Jugador" && myPresenceRef) {
                myPresenceRef.update({ name: myName }).catch(() => {});
                updateCardName("local", myName + " (TÚ)");
            }
        }, 1500);
    }

    // ---------- media ----------
    async function startMedia() {
        let soloAudio = false;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (errorConCamara) {
            localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            soloAudio = true;
        }
        addVideoCard("local", getMyDisplayName() + " (TÚ)", localStream, true, soloAudio);
        if (soloAudio) setVideoStatus("Conectado solo con audio", true);

        localStream.getTracks().forEach(track => {
            track.addEventListener("ended", () => {
                setVideoStatus("Cámara/micro cortados", false);
            });
        });
    }

    function createPeer() {
        const options = {
            host: "0.peerjs.com",
            port: 443,
            path: "/",
            secure: true,
            debug: 1,
            config: {
                iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" }
                ]
            }
        };
        peer = new Peer(options);

        peer.on("open", () => {
            setVideoStatus("Conectando con jugadores...", false);
            setupPresence();
        });

        peer.on("call", acceptCall);

        peer.on("disconnected", () => {
            // Se perdió la conexión con el servidor de señalización (no la
            // videollamada en sí). Reintenta reconectar sin perder el ID.
            if (!destroyed && peer && !peer.destroyed) {
                setVideoStatus("Reconectando...");
                try { peer.reconnect(); } catch (_) {}
            }
        });

        peer.on("error", err => {
            console.log("[webcams] error de PeerJS:", err && err.type);
            setVideoStatus("Error de enlace");
        });
    }

    async function iniciarVideollamada() {
        setVideoStatus("Conectando con jugadores...", false);
        try {
            await startMedia();
        } catch (e) {
            setVideoStatus("Sin cámara ni micrófono");
            return;
        }
        createPeer();
    }

function toggleMicrofono() {
    if (!localStream) return;
    micActivo = !micActivo;
    localStream.getAudioTracks().forEach(track => track.enabled = micActivo);
    const btn = document.getElementById("btnMic");
    if (btn) btn.classList.toggle("off", !micActivo);
}

function toggleCamara() {
    if (!localStream) return;
    camActiva = !camActiva;
    localStream.getVideoTracks().forEach(track => track.enabled = camActiva);
    const btn = document.getElementById("btnCam");
    if (btn) btn.classList.toggle("off", !camActiva);
    // Refleja el estado en tu propia tarjeta local (icono de "solo audio")
    const localCard = document.getElementById("video-card-local");
    if (localCard) localCard.classList.toggle("audio-only", !camActiva);
}




    function salirDeLaLlamada(navigate = true) {
        destroyed = true;

        try { if (roomRef) roomRef.off(); } catch (_) {}
        try { if (myPresenceRef) myPresenceRef.remove(); } catch (_) {}

        activeCalls.forEach(call => { try { call.close(); } catch (_) {} });
        activeCalls.clear();

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        if (peer) {
            try { peer.destroy(); } catch (_) {}
            peer = null;
        }
    }

    window.addEventListener("beforeunload", () => salirDeLaLlamada(false));
    window.addEventListener("pagehide", () => salirDeLaLlamada(false));

    // Expuestas globalmente porque el resto del HTML de la sala (botones de
    // puerta, etc.) las llama directamente.
    window.salirDeLaLlamada = salirDeLaLlamada;
    window.iniciarVideollamada = iniciarVideollamada;
window.toggleMicrofono = toggleMicrofono;
window.toggleCamara = toggleCamara;

    iniciarVideollamada();
})();
