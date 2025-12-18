import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, matchFilter } from 'nostr-tools'
import {
  generateEphemeralKeypair,
  generateSharedSecret,
  generateDeviceId,
  encryptInviteResponse,
  decryptInviteResponse,
  createSessionFromAccept,
} from '../src/inviteUtils'
import { INVITE_RESPONSE_KIND } from '../src/types'
import { createEventStream } from '../src/utils'

describe('inviteUtils', () => {
  describe('generateEphemeralKeypair', () => {
    it('returns valid keypair with 64 hex char keys', () => {
      const keypair = generateEphemeralKeypair()

      expect(keypair.privateKey).toBeInstanceOf(Uint8Array)
      expect(keypair.privateKey.length).toBe(32) // 32 bytes = 64 hex chars
      expect(keypair.publicKey).toHaveLength(64)
      expect(keypair.publicKey).toMatch(/^[0-9a-f]{64}$/)
    })

    it('publicKey derives correctly from privateKey', () => {
      const keypair = generateEphemeralKeypair()
      const derivedPublicKey = getPublicKey(keypair.privateKey)

      expect(keypair.publicKey).toBe(derivedPublicKey)
    })

    it('each call returns unique keypair', () => {
      const keypair1 = generateEphemeralKeypair()
      const keypair2 = generateEphemeralKeypair()

      expect(keypair1.publicKey).not.toBe(keypair2.publicKey)
    })
  })

  describe('generateSharedSecret', () => {
    it('returns 64 hex char string', () => {
      const secret = generateSharedSecret()

      expect(secret).toHaveLength(64)
      expect(secret).toMatch(/^[0-9a-f]{64}$/)
    })

    it('each call returns unique value', () => {
      const secret1 = generateSharedSecret()
      const secret2 = generateSharedSecret()

      expect(secret1).not.toBe(secret2)
    })
  })

  describe('generateDeviceId', () => {
    it('returns string of expected format', () => {
      const deviceId = generateDeviceId()

      expect(typeof deviceId).toBe('string')
      expect(deviceId.length).toBeGreaterThan(0)
    })

    it('each call returns unique value', () => {
      const deviceId1 = generateDeviceId()
      const deviceId2 = generateDeviceId()

      expect(deviceId1).not.toBe(deviceId2)
    })
  })

  describe('encryptInviteResponse + decryptInviteResponse', () => {
    it('round-trip returns original data', async () => {
      // Setup: known keys for inviter, invitee, ephemeral
      const inviterPrivateKey = generateSecretKey()
      const inviterPubkey = getPublicKey(inviterPrivateKey)

      const inviteePrivateKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteePrivateKey)

      const inviterEphemeral = generateEphemeralKeypair()
      const inviteeSessionKey = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const deviceId = 'test-device-123'

      // Encrypt
      const { event } = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKey.publicKey,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey,
        inviterPublicKey: inviterPubkey,
        inviterEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
        deviceId,
      })

      expect(event.kind).toBe(INVITE_RESPONSE_KIND)
      expect(event.tags).toContainEqual(['p', inviterEphemeral.publicKey])

      // Decrypt
      const result = await decryptInviteResponse({
        event,
        inviterEphemeralPrivateKey: inviterEphemeral.privateKey,
        inviterPrivateKey,
        sharedSecret,
      })

      expect(result.inviteePublicKey).toBe(inviteePubkey)
      expect(result.sessionKey).toBe(inviteeSessionKey.publicKey)
      expect(result.deviceId).toBe(deviceId)
    })

    it('round-trip works without deviceId', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPubkey = getPublicKey(inviterPrivateKey)

      const inviteePrivateKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteePrivateKey)

      const inviterEphemeral = generateEphemeralKeypair()
      const inviteeSessionKey = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const { event } = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKey.publicKey,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey,
        inviterPublicKey: inviterPubkey,
        inviterEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
      })

      const result = await decryptInviteResponse({
        event,
        inviterEphemeralPrivateKey: inviterEphemeral.privateKey,
        inviterPrivateKey,
        sharedSecret,
      })

      expect(result.inviteePublicKey).toBe(inviteePubkey)
      expect(result.sessionKey).toBe(inviteeSessionKey.publicKey)
      expect(result.deviceId).toBeUndefined()
    })

    it('decrypt fails with wrong inviterEphemeralPrivateKey', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPubkey = getPublicKey(inviterPrivateKey)

      const inviteePrivateKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteePrivateKey)

      const inviterEphemeral = generateEphemeralKeypair()
      const wrongEphemeral = generateEphemeralKeypair()
      const inviteeSessionKey = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const { event } = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKey.publicKey,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey,
        inviterPublicKey: inviterPubkey,
        inviterEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
      })

      await expect(decryptInviteResponse({
        event,
        inviterEphemeralPrivateKey: wrongEphemeral.privateKey,
        inviterPrivateKey,
        sharedSecret,
      })).rejects.toThrow()
    })

    it('decrypt fails with wrong sharedSecret', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPubkey = getPublicKey(inviterPrivateKey)

      const inviteePrivateKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteePrivateKey)

      const inviterEphemeral = generateEphemeralKeypair()
      const inviteeSessionKey = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const wrongSharedSecret = generateSharedSecret()

      const { event } = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKey.publicKey,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey,
        inviterPublicKey: inviterPubkey,
        inviterEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
      })

      await expect(decryptInviteResponse({
        event,
        inviterEphemeralPrivateKey: inviterEphemeral.privateKey,
        inviterPrivateKey,
        sharedSecret: wrongSharedSecret,
      })).rejects.toThrow()
    })

    it('decrypt fails with wrong inviterPrivateKey', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPubkey = getPublicKey(inviterPrivateKey)
      const wrongInviterPrivateKey = generateSecretKey()

      const inviteePrivateKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteePrivateKey)

      const inviterEphemeral = generateEphemeralKeypair()
      const inviteeSessionKey = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const { event } = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKey.publicKey,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey,
        inviterPublicKey: inviterPubkey,
        inviterEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
      })

      await expect(decryptInviteResponse({
        event,
        inviterEphemeralPrivateKey: inviterEphemeral.privateKey,
        inviterPrivateKey: wrongInviterPrivateKey,
        sharedSecret,
      })).rejects.toThrow()
    })
  })

  describe('createSessionFromAccept', () => {
    const dummySubscribe = vi.fn().mockReturnValue(() => {})

    it('creates valid session for initiator (isInitiator=true)', () => {
      const inviterEphemeral = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const { session, sessionKey } = createSessionFromAccept({
        nostrSubscribe: dummySubscribe,
        theirEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
        isInitiator: true,
      })

      expect(session).toBeDefined()
      expect(session.state).toBeDefined()
      expect(sessionKey.publicKey).toHaveLength(64)
      expect(sessionKey.privateKey).toBeInstanceOf(Uint8Array)
    })

    it('creates valid session for responder (isInitiator=false)', () => {
      const inviteeEphemeral = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const { session } = createSessionFromAccept({
        nostrSubscribe: dummySubscribe,
        theirEphemeralPublicKey: inviteeEphemeral.publicKey,
        sharedSecret,
        isInitiator: false,
        ourKeyPair: inviteeEphemeral,
      })

      expect(session).toBeDefined()
      expect(session.state).toBeDefined()
    })

    it('initiator + responder sessions can exchange messages', async () => {
      const inviterEphemeral = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const messageQueue: any[] = []
      const createSubscribe = () => (filter: any, onEvent: (event: any) => void) => {
        const checkQueue = () => {
          const index = messageQueue.findIndex(event => matchFilter(filter, event))
          if (index !== -1) {
            onEvent(messageQueue.splice(index, 1)[0])
          }
          setTimeout(checkQueue, 50)
        }
        checkQueue()
        return () => {}
      }

      // Create initiator session (invitee's side)
      const { session: initiatorSession, sessionKey: initiatorKey } = createSessionFromAccept({
        nostrSubscribe: createSubscribe(),
        theirEphemeralPublicKey: inviterEphemeral.publicKey,
        sharedSecret,
        isInitiator: true,
      })

      // Create responder session (inviter's side)
      const { session: responderSession } = createSessionFromAccept({
        nostrSubscribe: createSubscribe(),
        theirEphemeralPublicKey: initiatorKey.publicKey,
        sharedSecret,
        isInitiator: false,
        ourKeyPair: inviterEphemeral,
      })

      const initiatorMessages = createEventStream(initiatorSession)
      const responderMessages = createEventStream(responderSession)

      // Initiator sends first message
      messageQueue.push(initiatorSession.send('Hello from initiator!').event)
      const msg1 = await responderMessages.next()
      expect(msg1.value?.content).toBe('Hello from initiator!')

      // Responder replies
      messageQueue.push(responderSession.send('Hello from responder!').event)
      const msg2 = await initiatorMessages.next()
      expect(msg2.value?.content).toBe('Hello from responder!')

      // More back and forth
      messageQueue.push(initiatorSession.send('How are you?').event)
      const msg3 = await responderMessages.next()
      expect(msg3.value?.content).toBe('How are you?')

      messageQueue.push(responderSession.send('Doing great!').event)
      const msg4 = await initiatorMessages.next()
      expect(msg4.value?.content).toBe('Doing great!')
    })
  })
})
