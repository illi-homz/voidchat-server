import type { Socket } from 'socket.io';

export type MediaType = 'audio' | 'video';

export interface UserData {
	socket: Socket;
	userId: string;
	publicKey: string | null;
	lastSeen: number;
}

export interface PendingCallOffer {
	fromUserId: string;
	callId: string;
	sdp: string;
	mediaType: MediaType;
	timestamp: number;
}

export interface CallSession {
	callId: string;
	callerId: string;
	calleeId: string;
	mediaType: MediaType;
	status: 'pending' | 'ringing' | 'connected' | 'ended';
	sdp: string | null;
	callerSocket: Socket;
	calleeSocket: Socket | null;
	timeoutHandle: ReturnType<typeof setTimeout> | null;
	startedAt: number;
	connectedAt: number | null;
}
