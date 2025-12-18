import { generateSecretKey, getPublicKey, nip44, finalizeEvent, VerifiedEvent } from "nostr-tools";
import { getConversationKey } from "nostr-tools/nip44";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { Session } from "./Session";
import { INVITE_RESPONSE_KIND, NostrSubscribe, KeyPair } from "./types";

const TWO_DAYS = 2 * 24 * 60 * 60;
const randomNow = () => Math.round(Date.now() / 1000 - Math.random() * TWO_DAYS);

/**
 * Generate an ephemeral keypair for use in invite handshakes.
 * @returns Object with privateKey (Uint8Array) and publicKey (hex string)
 */
export function generateEphemeralKeypair(): KeyPair {
  const privateKey = generateSecretKey();
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Generate a random shared secret for initial handshake encryption.
 * @returns 64 character hex string
 */
export function generateSharedSecret(): string {
  return bytesToHex(generateSecretKey());
}

/**
 * Generate a unique device identifier.
 * @returns A random alphanumeric string
 */
export function generateDeviceId(): string {
  // Generate a random 16-byte value and encode as base36 for compact representation
  const bytes = generateSecretKey().slice(0, 16);
  return Array.from(bytes)
    .map(b => b.toString(36))
    .join('')
    .slice(0, 16);
}

export interface EncryptInviteResponseParams {
  inviteeSessionPublicKey: string;
  inviteePublicKey: string;
  inviteePrivateKey: Uint8Array;
  inviterPublicKey: string;
  inviterEphemeralPublicKey: string;
  sharedSecret: string;
  deviceId?: string;
}

export interface EncryptInviteResponseResult {
  event: VerifiedEvent;
}

/**
 * Encrypt an invite response for the inviter.
 *
 * Creates a double-encrypted response:
 * 1. Inner layer: Invitee's pubkey + sessionKey, encrypted with DH(inviter, invitee)
 * 2. Outer layer: Inner event encrypted with DH(randomSenderKey, inviterEphemeralPublicKey)
 *
 * This hides the invitee's identity from anyone else with access to the shared key.
 */
export async function encryptInviteResponse(params: EncryptInviteResponseParams): Promise<EncryptInviteResponseResult> {
  const {
    inviteeSessionPublicKey,
    inviteePublicKey,
    inviteePrivateKey,
    inviterPublicKey,
    inviterEphemeralPublicKey,
    sharedSecret,
    deviceId,
  } = params;

  const sharedSecretBytes = hexToBytes(sharedSecret);

  // Encrypt payload with DH(invitee, inviter)
  const payload = JSON.stringify({
    sessionKey: inviteeSessionPublicKey,
    deviceId: deviceId,
  });
  const dhEncrypted = nip44.encrypt(payload, getConversationKey(inviteePrivateKey, inviterPublicKey));

  // Create inner event (invitee's pubkey is visible here, but wrapped)
  const innerEvent = {
    pubkey: inviteePublicKey,
    content: nip44.encrypt(dhEncrypted, sharedSecretBytes),
    created_at: Math.floor(Date.now() / 1000),
  };
  const innerJson = JSON.stringify(innerEvent);

  // Create a random keypair for the envelope sender (hides invitee identity)
  const randomSenderKey = generateSecretKey();
  const randomSenderPublicKey = getPublicKey(randomSenderKey);

  // Create outer envelope
  const envelope = {
    kind: INVITE_RESPONSE_KIND,
    pubkey: randomSenderPublicKey,
    content: nip44.encrypt(innerJson, getConversationKey(randomSenderKey, inviterEphemeralPublicKey)),
    created_at: randomNow(),
    tags: [['p', inviterEphemeralPublicKey]],
  };

  return { event: finalizeEvent(envelope, randomSenderKey) };
}

export interface DecryptInviteResponseParams {
  event: VerifiedEvent;
  inviterEphemeralPrivateKey: Uint8Array;
  inviterPrivateKey: Uint8Array;
  sharedSecret: string;
}

export interface DecryptInviteResponseResult {
  inviteePublicKey: string;
  sessionKey: string;
  deviceId?: string;
}

/**
 * Decrypt an invite response from an invitee.
 *
 * Reverses the double-encryption:
 * 1. Decrypt outer envelope with DH(inviterEphemeralPrivateKey, eventPubkey)
 * 2. Decrypt inner content with shared secret
 * 3. Decrypt payload with DH(inviter, inviteePubkey)
 */
export async function decryptInviteResponse(params: DecryptInviteResponseParams): Promise<DecryptInviteResponseResult> {
  const {
    event,
    inviterEphemeralPrivateKey,
    inviterPrivateKey,
    sharedSecret,
  } = params;

  const sharedSecretBytes = hexToBytes(sharedSecret);

  // Decrypt the outer envelope
  const decrypted = nip44.decrypt(event.content, getConversationKey(inviterEphemeralPrivateKey, event.pubkey));
  const innerEvent = JSON.parse(decrypted);

  const inviteePublicKey = innerEvent.pubkey;

  // Decrypt the inner content using shared secret
  const dhEncrypted = nip44.decrypt(innerEvent.content, sharedSecretBytes);

  // Decrypt payload with DH(inviter, invitee)
  const decryptedPayload = nip44.decrypt(dhEncrypted, getConversationKey(inviterPrivateKey, inviteePublicKey));

  let sessionKey: string;
  let deviceId: string | undefined;

  try {
    const parsed = JSON.parse(decryptedPayload);
    sessionKey = parsed.sessionKey;
    deviceId = parsed.deviceId;
  } catch {
    // Backwards compatibility: payload might just be the session key
    sessionKey = decryptedPayload;
  }

  return { inviteePublicKey, sessionKey, deviceId };
}

export interface CreateSessionFromAcceptParams {
  nostrSubscribe: NostrSubscribe;
  theirEphemeralPublicKey: string;
  sharedSecret: string;
  isInitiator: boolean;
  ourKeyPair?: KeyPair;
  sessionName?: string;
}

export interface CreateSessionFromAcceptResult {
  session: Session;
  sessionKey: KeyPair;
}

/**
 * Create a new double ratchet session from invite acceptance.
 *
 * @param params.nostrSubscribe - Function to subscribe to Nostr events
 * @param params.theirEphemeralPublicKey - The other party's ephemeral public key
 * @param params.sharedSecret - The shared secret from the invite (hex string)
 * @param params.isInitiator - Whether we are the initiator (invitee=true, inviter=false)
 * @param params.ourKeyPair - Optional keypair to use (if not provided, generates new one)
 * @param params.sessionName - Optional name for the session (for debugging)
 * @returns The created session and the keypair used
 */
export function createSessionFromAccept(params: CreateSessionFromAcceptParams): CreateSessionFromAcceptResult {
  const {
    nostrSubscribe,
    theirEphemeralPublicKey,
    sharedSecret,
    isInitiator,
    ourKeyPair,
    sessionName,
  } = params;

  const sharedSecretBytes = hexToBytes(sharedSecret);
  const sessionKey = ourKeyPair ?? generateEphemeralKeypair();

  const session = Session.init(
    nostrSubscribe,
    theirEphemeralPublicKey,
    sessionKey.privateKey,
    isInitiator,
    sharedSecretBytes,
    sessionName
  );

  return { session, sessionKey };
}
