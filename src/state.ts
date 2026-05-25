import type { UserData, CallSession, PendingCallOffer } from './types.js';

/** Registered online users keyed by userId */
export const users = new Map<string, UserData>();

/** Pending friend requests for offline users (delivered on next register) */
export const pendingFriendRequests = new Map<
	string,
	Array<{ fromUserId: string; fromPublicKey: string | null }>
>();

/** Pending friend accept notifications for offline users */
export const pendingFriendAccepts = new Map<
	string,
	Array<{ fromUserId: string; fromPublicKey: string | null }>
>();

/** Pending messages for offline users (delivered on next register) */
export const pendingMessages = new Map<
	string,
	Array<{
		fromUserId: string;
		ciphertext: string;
		nonce: string;
		timestamp: number;
	}>
>();

/** Active call sessions keyed by callId */
export const activeCalls = new Map<string, CallSession>();

/** Tracks which user is in which active call (userId → callId) */
export const userActiveCall = new Map<string, string>();

/** Pending call offers for offline users */
export const pendingCallOffers = new Map<string, PendingCallOffer[]>();

/** Maximum pending auto-friend entries per user */
export const MAX_PENDING_AUTO_FRIENDS = 500;

/** Pending auto-friend notifications for offline inviters (delivered on next register) */
export const pendingAutoFriends = new Map<
	string,
	Array<{ userId: string; publicKey: string | null }>
>();

/** Rate-limit tracking: userId → { count, resetAt } */
export const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
