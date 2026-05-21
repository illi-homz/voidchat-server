import { randomUUID } from 'node:crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
const PORT = Number(process.env.PORT) || 9001;
const STARTED_AT = Date.now();
const MAX_CIPHERTEXT_LENGTH = 65536;
const MAX_NONCE_LENGTH = 128;
const MAX_SDP_LENGTH = 65536;
const MAX_USER_ID_LENGTH = 128;
const MAX_PUBLIC_KEY_LENGTH = 4096;
// TURN-сервер (для WebRTC звонков через NAT)
const TURN_HOST = process.env.TURN_HOST || ''; // если не задан — TURN не используется
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
if (TURN_HOST) {
    console.log(`[TURN] relay at ${TURN_HOST}:3478 (user: ${TURN_USERNAME})`);
}
else {
    console.log('[TURN] not configured (STUN-only, set TURN_HOST env var for relay across NAT)');
}
// Создаём HTTP-сервер (нужен для health-check и будущих HTTP-ручек)
const httpServer = createServer((req, res) => {
    // Health-check: GET / возвращает JSON-статус
    if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
            timestamp: new Date().toISOString(),
        }));
        return;
    }
    // TURN-конфигурация для WebRTC
    if (req.url === '/turn-config' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        // prettier-ignore
        res.end(
        // prettier-ignore
        JSON.stringify(TURN_HOST
            ? {
                // prettier-ignore
                urls: [`turn:${TURN_HOST}:3478`, `turn:${TURN_HOST}:3478?transport=tcp`],
                username: TURN_USERNAME,
                credential: TURN_CREDENTIAL,
            }
            : null));
        return;
    }
    // Все остальные запросы — 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});
// Socket.IO поверх HTTP-сервера
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    pingInterval: 25000,
    pingTimeout: 5000,
});
const users = new Map();
const pendingFriendRequests = new Map();
const pendingFriendAccepts = new Map();
const pendingMessages = new Map();
const activeCalls = new Map();
const userActiveCall = new Map();
const pendingCallOffers = new Map();
// Глобальный rate-limiter
const rateLimitMap = new Map();
function checkRateLimit(userId, maxRequests = 30, windowMs = 1000) {
    const now = Date.now();
    const entry = rateLimitMap.get(userId);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(userId, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (entry.count >= maxRequests)
        return false;
    entry.count++;
    return true;
}
// Очистка просроченных записей (раз в 60 секунд)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if (now > entry.resetAt)
            rateLimitMap.delete(key);
    }
}, 60000);
function cleanupCall(callId, reason) {
    const session = activeCalls.get(callId);
    if (!session)
        return;
    // Уведомить caller при таймауте
    if ((reason === 'no_answer' || reason === 'offline') && session.callerSocket) {
        session.callerSocket.emit('call_timedout', { callId, reason });
    }
    // Очистить таймаут
    if (session.timeoutHandle) {
        clearTimeout(session.timeoutHandle);
        session.timeoutHandle = null;
    }
    // Удалить из userActiveCall
    if (userActiveCall.get(session.callerId) === callId) {
        userActiveCall.delete(session.callerId);
    }
    if (session.calleeId && userActiveCall.get(session.calleeId) === callId) {
        userActiveCall.delete(session.calleeId);
    }
    // Очистить pendingCallOffers (только если calleeId задан)
    if (session.calleeId) {
        const pending = pendingCallOffers.get(session.calleeId);
        if (pending) {
            const filtered = pending.filter(p => p.callId !== callId);
            if (filtered.length === 0) {
                pendingCallOffers.delete(session.calleeId);
            }
            else {
                pendingCallOffers.set(session.calleeId, filtered);
            }
        }
    }
    activeCalls.delete(callId);
}
function cleanupPresence() {
    const now = Date.now();
    const TIMEOUT = 10 * 60 * 1000;
    for (const [userId, data] of users) {
        if (now - data.lastSeen > TIMEOUT) {
            const socket = data.socket;
            // Если у пользователя был активный звонок — завершить
            const activeCallId = userActiveCall.get(userId);
            if (activeCallId) {
                const session = activeCalls.get(activeCallId);
                if (session) {
                    // Определить второго участника
                    const _otherId = session.callerId === userId ? session.calleeId : session.callerId;
                    const otherSocket = session.callerId === userId ? session.calleeSocket : session.callerSocket;
                    // Отправить call_ended второму участнику ДО очистки сессии
                    if (otherSocket) {
                        otherSocket.emit('call_ended', {
                            callId: activeCallId,
                            duration: session.connectedAt
                                ? Math.floor((Date.now() - session.connectedAt) / 1000)
                                : 0,
                            endedBy: userId,
                        });
                    }
                    // Очистить таймаут
                    if (session.timeoutHandle) {
                        clearTimeout(session.timeoutHandle);
                        session.timeoutHandle = null;
                    }
                    // Удалить из userActiveCall
                    if (userActiveCall.get(session.callerId) === activeCallId) {
                        userActiveCall.delete(session.callerId);
                    }
                    if (session.calleeId && userActiveCall.get(session.calleeId) === activeCallId) {
                        userActiveCall.delete(session.calleeId);
                    }
                    // Очистить pendingCallOffers
                    if (session.calleeId) {
                        const pending = pendingCallOffers.get(session.calleeId);
                        if (pending) {
                            const filtered = pending.filter(p => p.callId !== activeCallId);
                            if (filtered.length === 0) {
                                pendingCallOffers.delete(session.calleeId);
                            }
                            else {
                                pendingCallOffers.set(session.calleeId, filtered);
                            }
                        }
                    }
                    activeCalls.delete(activeCallId);
                }
            }
            if (socket) {
                io.emit('presence', { userId, online: false });
                socket.disconnect();
            }
            users.delete(userId);
        }
    }
}
const presenceInterval = setInterval(cleanupPresence, 60000);
io.on('connection', (socket) => {
    let currentUserId = null;
    socket.on('register', (data) => {
        const { userId, publicKey } = data;
        if (!userId || typeof userId !== 'string') {
            socket.emit('error', { message: 'Invalid userId' });
            return;
        }
        if (userId.length > MAX_USER_ID_LENGTH ||
            (publicKey && publicKey.length > MAX_PUBLIC_KEY_LENGTH)) {
            socket.emit('error', { message: 'Invalid registration data' });
            return;
        }
        if (users.has(userId)) {
            const existing = users.get(userId);
            if (existing.socket) {
                existing.socket.emit('kicked', { message: 'Account logged in elsewhere' });
                existing.socket.disconnect();
            }
        }
        currentUserId = userId;
        users.set(userId, {
            socket,
            userId,
            publicKey: publicKey ?? null,
            lastSeen: Date.now(),
        });
        socket.emit('registered', { userId });
        io.emit('presence', { userId, online: true });
        const pending = pendingFriendRequests.get(userId);
        if (pending) {
            for (const req of pending) {
                socket.emit('friend_request', {
                    fromUserId: req.fromUserId,
                    fromPublicKey: req.fromPublicKey,
                });
            }
            pendingFriendRequests.delete(userId);
        }
        const pendingAccepts = pendingFriendAccepts.get(userId);
        if (pendingAccepts) {
            for (const acc of pendingAccepts) {
                socket.emit('friend_accepted', {
                    fromUserId: acc.fromUserId,
                    fromPublicKey: acc.fromPublicKey,
                });
            }
            pendingFriendAccepts.delete(userId);
        }
        // Доставляем накопившиеся офлайн-сообщения
        const pendingMsgs = pendingMessages.get(userId);
        if (pendingMsgs) {
            for (const msg of pendingMsgs) {
                socket.emit('message', {
                    from: msg.fromUserId,
                    ciphertext: msg.ciphertext,
                    nonce: msg.nonce,
                    timestamp: msg.timestamp,
                });
            }
            pendingMessages.delete(userId);
        }
        // Доставка офлайн-звонков
        const pendingCalls = pendingCallOffers.get(userId);
        if (pendingCalls && pendingCalls.length > 0) {
            for (const offer of pendingCalls) {
                const session = activeCalls.get(offer.callId);
                if (session && (session.status === 'pending' || session.status === 'ringing')) {
                    session.status = 'ringing';
                    session.calleeSocket = socket;
                    socket.emit('call_incoming', {
                        callId: offer.callId,
                        fromUserId: offer.fromUserId,
                        sdp: offer.sdp,
                    });
                    if (session.timeoutHandle)
                        clearTimeout(session.timeoutHandle);
                    session.timeoutHandle = setTimeout(() => {
                        if (session.status === 'ringing' || session.status === 'pending') {
                            cleanupCall(session.callId, 'no_answer');
                        }
                    }, 60000);
                }
            }
            pendingCallOffers.delete(userId);
        }
    });
    socket.on('heartbeat', () => {
        if (!currentUserId)
            return;
        const user = users.get(currentUserId);
        if (user) {
            user.lastSeen = Date.now();
        }
    });
    socket.on('get_presence', (data) => {
        const { userIds } = data;
        if (!Array.isArray(userIds))
            return;
        const presence = {};
        for (const uid of userIds) {
            presence[uid] = users.has(uid);
        }
        socket.emit('presence_batch', presence);
    });
    socket.on('friend_request', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { targetUserId } = data;
        if (typeof targetUserId !== 'string' || targetUserId.length > MAX_USER_ID_LENGTH) {
            socket.emit('error', { message: 'Invalid target' });
            return;
        }
        if (!targetUserId || targetUserId === currentUserId) {
            socket.emit('error', { message: 'Invalid target' });
            return;
        }
        const target = users.get(targetUserId);
        const requester = users.get(currentUserId);
        if (!target || !target.socket) {
            const existing = pendingFriendRequests.get(targetUserId) || [];
            const MAX_PENDING_FRIEND_REQUESTS = 500;
            if (existing.length >= MAX_PENDING_FRIEND_REQUESTS) {
                existing.shift();
            }
            existing.push({
                fromUserId: currentUserId,
                fromPublicKey: requester?.publicKey ?? null,
            });
            pendingFriendRequests.set(targetUserId, existing);
            socket.emit('friend_request_sent', { targetUserId, targetPublicKey: null });
            return;
        }
        target.socket.emit('friend_request', {
            fromUserId: currentUserId,
            fromPublicKey: requester?.publicKey ?? null,
        });
        socket.emit('friend_request_sent', { targetUserId, targetPublicKey: target.publicKey });
    });
    socket.on('friend_accept', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { targetUserId } = data;
        if (!targetUserId ||
            typeof targetUserId !== 'string' ||
            targetUserId.length > MAX_USER_ID_LENGTH) {
            return;
        }
        const initiator = users.get(targetUserId);
        const acceptor = users.get(currentUserId);
        if (!initiator || !initiator.socket) {
            const existing = pendingFriendAccepts.get(targetUserId) || [];
            const MAX_PENDING_FRIEND_REQUESTS = 500;
            if (existing.length >= MAX_PENDING_FRIEND_REQUESTS) {
                existing.shift();
            }
            existing.push({
                fromUserId: currentUserId,
                fromPublicKey: acceptor?.publicKey ?? null,
            });
            pendingFriendAccepts.set(targetUserId, existing);
        }
        else {
            initiator.socket.emit('friend_accepted', {
                fromUserId: currentUserId,
                fromPublicKey: acceptor?.publicKey ?? null,
            });
        }
        socket.emit('friend_confirmed', {
            targetUserId,
            targetPublicKey: initiator?.publicKey ?? null,
        });
    });
    socket.on('friend_decline', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { targetUserId } = data;
        if (!targetUserId ||
            typeof targetUserId !== 'string' ||
            targetUserId.length > MAX_USER_ID_LENGTH) {
            socket.emit('error', { message: 'Invalid target' });
            return;
        }
        const target = users.get(targetUserId);
        if (target?.socket) {
            target.socket.emit('friend_declined', { fromUserId: currentUserId });
        }
    });
    socket.on('message', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { to, ciphertext, nonce } = data;
        if (!to || !ciphertext || !nonce) {
            socket.emit('error', { message: 'Invalid message format' });
            return;
        }
        if (typeof to !== 'string' || typeof ciphertext !== 'string' || typeof nonce !== 'string') {
            socket.emit('error', { message: 'Invalid message format' });
            return;
        }
        if (ciphertext.length > MAX_CIPHERTEXT_LENGTH || nonce.length > MAX_NONCE_LENGTH) {
            socket.emit('error', { message: 'Message payload too large' });
            return;
        }
        const target = users.get(to);
        if (!target?.socket) {
            // Получатель офлайн — сохраняем в очередь
            const existing = pendingMessages.get(to) || [];
            const MAX_PENDING_MESSAGES = 1000;
            if (existing.length >= MAX_PENDING_MESSAGES) {
                existing.shift();
            }
            existing.push({ fromUserId: currentUserId, ciphertext, nonce, timestamp: Date.now() });
            pendingMessages.set(to, existing);
            socket.emit('message_sent', { to, ciphertext, nonce, timestamp: Date.now() });
            return;
        }
        target.socket.emit('message', {
            from: currentUserId,
            ciphertext,
            nonce,
            timestamp: Date.now(),
        });
        socket.emit('message_sent', { to, ciphertext, nonce, timestamp: Date.now() });
    });
    socket.on('messages_read', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        // Уведомляем собеседника, что его сообщения прочитаны
        const target = users.get(data.contactId);
        if (target?.socket) {
            target.socket.emit('messages_read', { readBy: currentUserId });
        }
    });
    socket.on('call_offer', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId, 1, 1000)) {
            socket.emit('error', { message: 'Too many requests' });
            return;
        }
        const { targetUserId, sdp, callId } = data;
        if (!targetUserId || !sdp || targetUserId === currentUserId) {
            socket.emit('error', { message: 'Invalid call offer' });
            return;
        }
        if (typeof sdp !== 'string' || sdp.length > MAX_SDP_LENGTH) {
            socket.emit('error', { message: 'Invalid call offer' });
            return;
        }
        const targetUser = users.get(targetUserId);
        // Если targetUser не найден — обработать как офлайн (поставить в очередь)
        if (!targetUser) {
            const callId = data.callId || randomUUID();
            // Положить в офлайн-очередь
            const existing = pendingCallOffers.get(targetUserId) || [];
            if (existing.length >= 10)
                existing.shift(); // ограничение 10 офлайн-звонков
            existing.push({ fromUserId: currentUserId, callId, sdp, timestamp: Date.now() });
            pendingCallOffers.set(targetUserId, existing);
            // Создать сессию
            const session = {
                callId,
                callerId: currentUserId,
                calleeId: targetUserId,
                status: 'pending',
                sdp,
                callerSocket: socket,
                calleeSocket: null,
                timeoutHandle: null,
                startedAt: Date.now(),
                connectedAt: null,
            };
            activeCalls.set(callId, session);
            userActiveCall.set(currentUserId, callId);
            userActiveCall.set(targetUserId, callId);
            // Таймаут 60 секунд
            session.timeoutHandle = setTimeout(() => {
                cleanupCall(callId, 'no_answer');
            }, 60000);
            // Подтверждение отправителю
            socket.emit('call_offer_sent', { callId, targetUserId });
            return;
        }
        // BUG-001: Проверить, не занят ли target пользователь другим звонком
        if (userActiveCall.has(targetUserId)) {
            socket.emit('error', { message: 'User is busy' });
            return;
        }
        // Проверка на активный звонок
        const existingCallId = userActiveCall.get(currentUserId);
        if (existingCallId) {
            // Если callId передан и совпадает с существующим звонком — это renegotiation
            if (callId && existingCallId === callId) {
                const existingSession = activeCalls.get(existingCallId);
                if (existingSession) {
                    existingSession.sdp = sdp;
                    // Определяем сокет другой стороны
                    const otherSocket = existingSession.callerId === currentUserId
                        ? existingSession.calleeSocket
                        : existingSession.callerSocket;
                    if (otherSocket) {
                        otherSocket.emit('call_incoming', {
                            callId,
                            fromUserId: currentUserId,
                            sdp,
                        });
                    }
                    return;
                }
            }
            socket.emit('error', { message: 'You already have an active call' });
            return;
        }
        const newCallId = data.callId || randomUUID();
        const session = {
            callId: newCallId,
            callerId: currentUserId,
            calleeId: targetUserId,
            status: 'pending',
            sdp,
            callerSocket: socket,
            calleeSocket: null,
            timeoutHandle: null,
            startedAt: Date.now(),
            connectedAt: null,
        };
        activeCalls.set(newCallId, session);
        userActiveCall.set(currentUserId, newCallId);
        userActiveCall.set(targetUserId, newCallId);
        if (targetUser.socket) {
            session.status = 'ringing';
            session.calleeSocket = targetUser.socket;
            targetUser.socket.emit('call_incoming', {
                callId: newCallId,
                fromUserId: currentUserId,
                sdp,
            });
            session.timeoutHandle = setTimeout(() => {
                if (session.status === 'ringing' || session.status === 'pending') {
                    cleanupCall(newCallId, 'no_answer');
                }
            }, 60000);
        }
        else {
            const existing = pendingCallOffers.get(targetUserId) || [];
            existing.push({
                fromUserId: currentUserId,
                callId: newCallId,
                sdp,
                timestamp: Date.now(),
            });
            pendingCallOffers.set(targetUserId, existing);
            session.timeoutHandle = setTimeout(() => {
                if (session.status === 'ringing' || session.status === 'pending') {
                    cleanupCall(newCallId, 'no_answer');
                }
            }, 60000);
        }
        socket.emit('call_offer_sent', { callId: newCallId, targetUserId });
    });
    socket.on('call_accept', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { callId, sdp } = data;
        if (!callId || !sdp) {
            socket.emit('error', { message: 'Invalid call accept' });
            return;
        }
        const session = activeCalls.get(callId);
        if (!session) {
            socket.emit('error', { message: 'Call not found' });
            return;
        }
        // Renegotiation answer (ICE restart) — соединение уже активно
        if (session.status === 'connected') {
            session.sdp = sdp;
            // Определяем, кому отправить answer
            const targetSocket = currentUserId === session.callerId ? session.calleeSocket : session.callerSocket;
            if (targetSocket) {
                targetSocket.emit('call_accepted', { callId, sdp });
            }
            return;
        }
        if (session.status !== 'pending' && session.status !== 'ringing') {
            socket.emit('error', { message: 'Call is not active' });
            return;
        }
        if (currentUserId !== session.calleeId) {
            socket.emit('error', { message: 'Only the callee can accept this call' });
            return;
        }
        session.status = 'connected';
        session.connectedAt = Date.now();
        session.calleeSocket = socket;
        session.sdp = sdp;
        if (session.timeoutHandle) {
            clearTimeout(session.timeoutHandle);
            session.timeoutHandle = null;
        }
        userActiveCall.set(session.calleeId, callId);
        session.callerSocket.emit('call_accepted', { callId, sdp });
    });
    socket.on('call_decline', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { callId } = data;
        if (!callId) {
            socket.emit('error', { message: 'Invalid call decline' });
            return;
        }
        const session = activeCalls.get(callId);
        if (!session) {
            socket.emit('error', { message: 'Call not found' });
            return;
        }
        if (currentUserId !== session.calleeId) {
            socket.emit('error', { message: 'Only the callee can decline this call' });
            return;
        }
        session.callerSocket.emit('call_declined', { callId, reason: 'declined' });
        cleanupCall(callId, 'declined');
    });
    socket.on('call_hangup', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { callId } = data;
        if (!callId) {
            socket.emit('error', { message: 'Invalid call hangup' });
            return;
        }
        const session = activeCalls.get(callId);
        if (!session) {
            socket.emit('error', { message: 'Call not found' });
            return;
        }
        if (currentUserId !== session.callerId && currentUserId !== session.calleeId) {
            socket.emit('error', { message: 'Not a participant of this call' });
            return;
        }
        const duration = session.connectedAt
            ? Math.floor((Date.now() - session.connectedAt) / 1000)
            : 0;
        const _otherUserId = session.callerId === currentUserId ? session.calleeId : session.callerId;
        const otherSocket = session.callerId === currentUserId ? session.calleeSocket : session.callerSocket;
        if (otherSocket) {
            otherSocket.emit('call_ended', {
                callId,
                duration,
                endedBy: currentUserId,
            });
        }
        cleanupCall(callId, 'ended');
    });
    socket.on('ice_candidate', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not registered' });
            return;
        }
        if (!checkRateLimit(currentUserId)) {
            socket.emit('error', { message: 'Rate limited' });
            return;
        }
        const { callId, candidate } = data;
        if (!callId || !candidate) {
            socket.emit('error', { message: 'Invalid ICE candidate' });
            return;
        }
        if (typeof candidate !== 'string') {
            socket.emit('error', { message: 'Invalid ICE candidate' });
            return;
        }
        const session = activeCalls.get(callId);
        if (!session) {
            socket.emit('error', { message: 'Call not found' });
            return;
        }
        if (currentUserId !== session.callerId && currentUserId !== session.calleeId) {
            socket.emit('error', { message: 'Not a participant of this call' });
            return;
        }
        const _otherUserId = session.callerId === currentUserId ? session.calleeId : session.callerId;
        const otherSocket = session.callerId === currentUserId ? session.calleeSocket : session.callerSocket;
        if (otherSocket) {
            otherSocket.emit('ice_candidate', { callId, candidate });
        }
    });
    socket.on('disconnect', () => {
        if (currentUserId) {
            // Если у пользователя был активный звонок — завершить
            const activeCallId = userActiveCall.get(currentUserId);
            if (activeCallId) {
                const session = activeCalls.get(activeCallId);
                if (session) {
                    const _otherId = session.callerId === currentUserId ? session.calleeId : session.callerId;
                    const otherSocket = session.callerId === currentUserId
                        ? session.calleeSocket
                        : session.callerSocket;
                    if (otherSocket) {
                        otherSocket.emit('call_ended', {
                            callId: activeCallId,
                            duration: 0,
                            endedBy: currentUserId,
                        });
                    }
                    cleanupCall(activeCallId, 'offline');
                }
            }
            users.delete(currentUserId);
            io.emit('presence', { userId: currentUserId, online: false });
        }
    });
});
httpServer.listen(PORT, () => {
    console.log(`VoidChat server running on http://0.0.0.0:${PORT}`);
    console.log(`Health check: http://0.0.0.0:${PORT}/`);
});
function gracefulShutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    clearInterval(presenceInterval);
    // Завершить все активные звонки
    for (const [, session] of activeCalls) {
        if (session.timeoutHandle) {
            clearTimeout(session.timeoutHandle);
        }
        // Уведомить участников
        if (session.callerSocket) {
            session.callerSocket.emit('call_ended', {
                callId: session.callId,
                duration: 0,
                endedBy: 'server',
            });
        }
        if (session.calleeSocket) {
            session.calleeSocket.emit('call_ended', {
                callId: session.callId,
                duration: 0,
                endedBy: 'server',
            });
        }
    }
    activeCalls.clear();
    userActiveCall.clear();
    pendingCallOffers.clear();
    io.close();
    httpServer.close(() => process.exit(0));
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
