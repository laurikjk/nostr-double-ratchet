import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, matchFilter } from 'nostr-tools'
import { InviteList, DeviceEntry } from '../src/InviteList'
import { INVITE_LIST_KIND, INVITE_RESPONSE_KIND } from '../src/types'
import { generateEphemeralKeypair, generateSharedSecret, generateDeviceId } from '../src/inviteUtils'
import { createEventStream } from '../src/utils'

function createDeviceEntry(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  const keypair = generateEphemeralKeypair()
  return {
    ephemeralPublicKey: keypair.publicKey,
    sharedSecret: generateSharedSecret(),
    deviceId: generateDeviceId(),
    label: 'Test Device',
    ephemeralPrivateKey: keypair.privateKey,
    ...overrides,
  }
}

describe('InviteList', () => {
  describe('fromEvent', () => {
    it('parses valid invite list event', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const device1 = createDeviceEntry({ label: 'Phone' })
      const device2 = createDeviceEntry({ label: 'Laptop' })

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'double-ratchet/invite-list'],
          ['device', device1.ephemeralPublicKey, device1.sharedSecret, device1.deviceId, device1.label],
          ['device', device2.ephemeralPublicKey, device2.sharedSecret, device2.deviceId, device2.label],
          ['main-device', device1.deviceId],
          ['version', '1'],
        ],
        content: '',
      }, ownerKey)

      const list = InviteList.fromEvent(event)

      expect(list.owner).toBe(ownerPubkey)
      expect(list.getAllDevices()).toHaveLength(2)
      expect(list.getDevice(device1.deviceId)?.label).toBe('Phone')
      expect(list.getDevice(device2.deviceId)?.label).toBe('Laptop')
      expect(list.mainDeviceId).toBe(device1.deviceId)
      expect(list.version).toBe(1)
    })

    it('extracts removed entries with timestamps', () => {
      const ownerKey = generateSecretKey()
      const removedDeviceId = generateDeviceId()
      const timestamp = Math.floor(Date.now() / 1000)

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: timestamp,
        tags: [
          ['d', 'double-ratchet/invite-list'],
          ['removed', removedDeviceId, String(timestamp)],
          ['version', '1'],
        ],
        content: '',
      }, ownerKey)

      const list = InviteList.fromEvent(event)

      expect(list.removed).toHaveLength(1)
      expect(list.removed[0].deviceId).toBe(removedDeviceId)
      expect(list.removed[0].timestamp).toBe(timestamp)
    })

    it('extracts mainDeviceId from tag', () => {
      const ownerKey = generateSecretKey()
      const device = createDeviceEntry()

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'double-ratchet/invite-list'],
          ['device', device.ephemeralPublicKey, device.sharedSecret, device.deviceId, device.label],
          ['main-device', device.deviceId],
        ],
        content: '',
      }, ownerKey)

      const list = InviteList.fromEvent(event)
      expect(list.mainDeviceId).toBe(device.deviceId)
    })

    it('extracts version from tag', () => {
      const ownerKey = generateSecretKey()

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'double-ratchet/invite-list'],
          ['version', '2'],
        ],
        content: '',
      }, ownerKey)

      const list = InviteList.fromEvent(event)
      expect(list.version).toBe(2)
    })

    it('handles empty device list', () => {
      const ownerKey = generateSecretKey()

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'double-ratchet/invite-list'],
        ],
        content: '',
      }, ownerKey)

      const list = InviteList.fromEvent(event)
      expect(list.getAllDevices()).toHaveLength(0)
    })

    it('ignores malformed device tags (wrong length, missing fields)', () => {
      const ownerKey = generateSecretKey()
      const validDevice = createDeviceEntry()

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'double-ratchet/invite-list'],
          ['device', validDevice.ephemeralPublicKey, validDevice.sharedSecret, validDevice.deviceId, validDevice.label],
          ['device', 'only-one-field'], // malformed
          ['device', 'two', 'fields'], // malformed
          ['device', 'three', 'fields', 'here'], // malformed - missing label
        ],
        content: '',
      }, ownerKey)

      const list = InviteList.fromEvent(event)
      expect(list.getAllDevices()).toHaveLength(1)
      expect(list.getDevice(validDevice.deviceId)).toBeDefined()
    })
  })

  describe('getEvent', () => {
    it('produces valid kind 10078 event', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)

      const event = list.getEvent()

      expect(event.kind).toBe(INVITE_LIST_KIND)
      expect(event.pubkey).toBe(ownerPubkey)
    })

    it('includes all device tags with correct structure', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)

      const event = list.getEvent()

      const deviceTag = event.tags.find(t => t[0] === 'device')
      expect(deviceTag).toBeDefined()
      expect(deviceTag).toEqual(['device', device.ephemeralPublicKey, device.sharedSecret, device.deviceId, device.label])
    })

    it('includes removed tags with timestamps', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)
      list.removeDevice(device.deviceId)

      const event = list.getEvent()

      const removedTag = event.tags.find(t => t[0] === 'removed')
      expect(removedTag).toBeDefined()
      expect(removedTag![1]).toBe(device.deviceId)
      expect(Number(removedTag![2])).toBeGreaterThan(0)
    })

    it('includes main-device tag if set', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)
      list.mainDeviceId = device.deviceId

      const event = list.getEvent()

      const mainDeviceTag = event.tags.find(t => t[0] === 'main-device')
      expect(mainDeviceTag).toEqual(['main-device', device.deviceId])
    })

    it('includes version tag', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)

      const event = list.getEvent()

      const versionTag = event.tags.find(t => t[0] === 'version')
      expect(versionTag).toEqual(['version', '1'])
    })
  })

  describe('fromEvent + getEvent round-trip', () => {
    it('fromEvent(list.getEvent()) preserves data', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)
      const device1 = createDeviceEntry({ label: 'Device 1' })
      const device2 = createDeviceEntry({ label: 'Device 2' })

      // Remove private keys before adding (simulating parsing from event)
      list.addDevice({ ...device1, ephemeralPrivateKey: undefined })
      list.addDevice({ ...device2, ephemeralPrivateKey: undefined })
      list.mainDeviceId = device1.deviceId

      const event = list.getEvent()
      const signedEvent = finalizeEvent(event, ownerKey)
      const parsed = InviteList.fromEvent(signedEvent)

      expect(parsed.owner).toBe(ownerPubkey)
      expect(parsed.getAllDevices()).toHaveLength(2)
      expect(parsed.getDevice(device1.deviceId)?.label).toBe('Device 1')
      expect(parsed.getDevice(device2.deviceId)?.label).toBe('Device 2')
      expect(parsed.mainDeviceId).toBe(device1.deviceId)
    })
  })

  describe('addDevice', () => {
    it('adds device to list', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()

      list.addDevice(device)

      expect(list.getAllDevices()).toContainEqual(expect.objectContaining({
        deviceId: device.deviceId,
        label: device.label,
      }))
    })

    it('replaces existing device with same deviceId', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry({ label: 'Original' })

      list.addDevice(device)
      list.addDevice({ ...device, label: 'Updated' })

      expect(list.getAllDevices()).toHaveLength(1)
      expect(list.getDevice(device.deviceId)?.label).toBe('Updated')
    })

    it('does not add device that exists in removed list', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()

      list.addDevice(device)
      list.removeDevice(device.deviceId)

      // Try to re-add
      list.addDevice(device)

      expect(list.getAllDevices()).toHaveLength(0)
      expect(list.removed).toHaveLength(1)
    })
  })

  describe('removeDevice', () => {
    it('moves device to removed list with timestamp', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)

      const beforeRemove = Math.floor(Date.now() / 1000)
      list.removeDevice(device.deviceId)
      const afterRemove = Math.floor(Date.now() / 1000)

      expect(list.getAllDevices()).toHaveLength(0)
      expect(list.removed).toHaveLength(1)
      expect(list.removed[0].deviceId).toBe(device.deviceId)
      expect(list.removed[0].timestamp).toBeGreaterThanOrEqual(beforeRemove)
      expect(list.removed[0].timestamp).toBeLessThanOrEqual(afterRemove)
    })

    it('no-op for unknown deviceId', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)

      list.removeDevice('unknown-device-id')

      expect(list.getAllDevices()).toHaveLength(1)
      expect(list.removed).toHaveLength(0)
    })
  })

  describe('getDevice', () => {
    it('returns correct device by id', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry({ label: 'My Phone' })
      list.addDevice(device)

      const found = list.getDevice(device.deviceId)

      expect(found?.label).toBe('My Phone')
      expect(found?.deviceId).toBe(device.deviceId)
    })

    it('returns undefined for unknown id', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)

      expect(list.getDevice('unknown')).toBeUndefined()
    })

    it('returns undefined for removed device', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)
      list.removeDevice(device.deviceId)

      expect(list.getDevice(device.deviceId)).toBeUndefined()
    })
  })

  describe('getAllDevices', () => {
    it('returns only active devices (not removed)', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)
      const device1 = createDeviceEntry({ label: 'Device 1' })
      const device2 = createDeviceEntry({ label: 'Device 2' })
      const device3 = createDeviceEntry({ label: 'Device 3' })

      list.addDevice(device1)
      list.addDevice(device2)
      list.addDevice(device3)
      list.removeDevice(device2.deviceId)

      const devices = list.getAllDevices()

      expect(devices).toHaveLength(2)
      expect(devices.find(d => d.deviceId === device1.deviceId)).toBeDefined()
      expect(devices.find(d => d.deviceId === device2.deviceId)).toBeUndefined()
      expect(devices.find(d => d.deviceId === device3.deviceId)).toBeDefined()
    })
  })

  describe('merge', () => {
    it('unions devices from both lists', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list1 = InviteList.create(ownerPubkey)
      const list2 = InviteList.create(ownerPubkey)

      const deviceA = createDeviceEntry({ label: 'Device A' })
      const deviceB = createDeviceEntry({ label: 'Device B' })

      list1.addDevice(deviceA)
      list2.addDevice(deviceB)

      const merged = list1.merge(list2)

      expect(merged.getAllDevices()).toHaveLength(2)
      expect(merged.getDevice(deviceA.deviceId)).toBeDefined()
      expect(merged.getDevice(deviceB.deviceId)).toBeDefined()
    })

    it('unions removed entries from both lists', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list1 = InviteList.create(ownerPubkey)
      const list2 = InviteList.create(ownerPubkey)

      const deviceA = createDeviceEntry()
      const deviceB = createDeviceEntry()

      list1.addDevice(deviceA)
      list1.removeDevice(deviceA.deviceId)

      list2.addDevice(deviceB)
      list2.removeDevice(deviceB.deviceId)

      const merged = list1.merge(list2)

      expect(merged.removed).toHaveLength(2)
      expect(merged.removed.find(r => r.deviceId === deviceA.deviceId)).toBeDefined()
      expect(merged.removed.find(r => r.deviceId === deviceB.deviceId)).toBeDefined()
    })

    it('filters out devices that appear in removed', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list1 = InviteList.create(ownerPubkey)
      const list2 = InviteList.create(ownerPubkey)

      const device = createDeviceEntry()

      list1.addDevice(device)
      // list2 has it removed
      list2.removed.push({ deviceId: device.deviceId, timestamp: Math.floor(Date.now() / 1000) })

      const merged = list1.merge(list2)

      expect(merged.getAllDevices()).toHaveLength(0)
      expect(merged.removed).toHaveLength(1)
    })

    it('dedupes devices by deviceId, keeps latest', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list1 = InviteList.create(ownerPubkey)
      const list2 = InviteList.create(ownerPubkey)

      const deviceId = generateDeviceId()
      const device1 = createDeviceEntry({ deviceId, label: 'Old Label' })
      const device2 = createDeviceEntry({ deviceId, label: 'New Label' })

      list1.addDevice(device1)
      list2.addDevice(device2)

      // Force list2's device to appear "newer" by giving list2 a higher createdAt
      list2.createdAt = list1.createdAt + 100

      const merged = list1.merge(list2)

      expect(merged.getAllDevices()).toHaveLength(1)
      expect(merged.getDevice(deviceId)?.label).toBe('New Label')
    })

    it('merge is commutative: merge(a,b) equals merge(b,a)', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list1 = InviteList.create(ownerPubkey)
      const list2 = InviteList.create(ownerPubkey)

      const deviceA = createDeviceEntry({ label: 'A' })
      const deviceB = createDeviceEntry({ label: 'B' })

      list1.addDevice(deviceA)
      list2.addDevice(deviceB)

      const merged1 = list1.merge(list2)
      const merged2 = list2.merge(list1)

      expect(merged1.getAllDevices().map(d => d.deviceId).sort())
        .toEqual(merged2.getAllDevices().map(d => d.deviceId).sort())
    })
  })

  describe('accept', () => {
    const dummySubscribe = vi.fn().mockReturnValue(() => {})

    it('creates session and response event', async () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      list.addDevice(device)

      const inviteeKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteeKey)

      const { session, event } = await list.accept({
        deviceId: device.deviceId,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey: inviteeKey,
        nostrSubscribe: dummySubscribe,
      })

      expect(session).toBeDefined()
      expect(session.state).toBeDefined()
      expect(event.kind).toBe(INVITE_RESPONSE_KIND)
      expect(event.tags).toContainEqual(['p', device.ephemeralPublicKey])
    })

    it('throws for unknown deviceId', async () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const list = InviteList.create(ownerPubkey)

      const inviteeKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteeKey)

      await expect(list.accept({
        deviceId: 'unknown',
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey: inviteeKey,
        nostrSubscribe: dummySubscribe,
      })).rejects.toThrow()
    })
  })

  describe('listen', () => {
    it('receives acceptance and creates session', async () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)
      const device = createDeviceEntry() // Has private key
      list.addDevice(device)

      const inviteeKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteeKey)

      // Create acceptance event
      const { event: acceptEvent } = await list.accept({
        deviceId: device.deviceId,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey: inviteeKey,
        nostrSubscribe: vi.fn().mockReturnValue(() => {}),
      })

      const onSession = vi.fn()

      const mockSubscribe = (filter: any, callback: (event: any) => void) => {
        expect(filter.kinds).toEqual([INVITE_RESPONSE_KIND])
        expect(filter['#p']).toEqual([device.ephemeralPublicKey])
        callback(acceptEvent)
        return () => {}
      }

      list.listen({
        deviceId: device.deviceId,
        ownerPrivateKey: ownerKey,
        nostrSubscribe: mockSubscribe,
        onSession,
      })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(onSession).toHaveBeenCalledTimes(1)
      const [session, identity] = onSession.mock.calls[0]
      expect(session).toBeDefined()
      expect(identity).toBe(inviteePubkey)
    })

    it('throws for device without privateKey', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const list = InviteList.create(ownerPubkey)

      // Add device without private key (simulating parsed from event)
      const device = createDeviceEntry()
      list.addDevice({ ...device, ephemeralPrivateKey: undefined })

      expect(() => list.listen({
        deviceId: device.deviceId,
        ownerPrivateKey: ownerKey,
        nostrSubscribe: vi.fn(),
        onSession: vi.fn(),
      })).toThrow()
    })
  })

  describe('subscribe', () => {
    it('calls onList when receiving valid InviteList event', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const device = createDeviceEntry()

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'double-ratchet/invite-list'],
          ['device', device.ephemeralPublicKey, device.sharedSecret, device.deviceId, device.label],
        ],
        content: '',
      }, ownerKey)

      const onList = vi.fn()
      let capturedCallback: (event: any) => void

      const mockSubscribe = vi.fn().mockImplementation((filter: any, callback: (event: any) => void) => {
        expect(filter.kinds).toEqual([INVITE_LIST_KIND])
        expect(filter.authors).toEqual([ownerPubkey])
        expect(filter['#d']).toEqual(['double-ratchet/invite-list'])
        capturedCallback = callback
        return () => {}
      })

      InviteList.subscribe(ownerPubkey, mockSubscribe, onList)
      capturedCallback!(event)

      expect(onList).toHaveBeenCalledTimes(1)
      const receivedList = onList.mock.calls[0][0]
      expect(receivedList.owner).toBe(ownerPubkey)
      expect(receivedList.getAllDevices()).toHaveLength(1)
    })

    it('ignores events from wrong pubkey', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const wrongKey = generateSecretKey()

      const event = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', 'double-ratchet/invite-list']],
        content: '',
      }, wrongKey)

      const onList = vi.fn()
      let capturedCallback: (event: any) => void

      const mockSubscribe = vi.fn().mockImplementation((filter: any, callback: (event: any) => void) => {
        capturedCallback = callback
        return () => {}
      })

      InviteList.subscribe(ownerPubkey, mockSubscribe, onList)
      capturedCallback!(event)

      expect(onList).not.toHaveBeenCalled()
    })

    it('ignores older events than previously received', () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const now = Math.floor(Date.now() / 1000)

      const newerEvent = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: now + 100,
        tags: [['d', 'double-ratchet/invite-list']],
        content: '',
      }, ownerKey)

      const olderEvent = finalizeEvent({
        kind: INVITE_LIST_KIND,
        created_at: now,
        tags: [['d', 'double-ratchet/invite-list']],
        content: '',
      }, ownerKey)

      const onList = vi.fn()
      let capturedCallback: (event: any) => void

      const mockSubscribe = vi.fn().mockImplementation((filter: any, callback: (event: any) => void) => {
        capturedCallback = callback
        return () => {}
      })

      InviteList.subscribe(ownerPubkey, mockSubscribe, onList)

      // Receive newer event first
      capturedCallback!(newerEvent)
      expect(onList).toHaveBeenCalledTimes(1)

      // Receive older event - should be ignored
      capturedCallback!(olderEvent)
      expect(onList).toHaveBeenCalledTimes(1)
    })

    it('returns unsubscribe function', () => {
      const ownerPubkey = getPublicKey(generateSecretKey())
      const unsubFn = vi.fn()
      const mockSubscribe = vi.fn().mockReturnValue(unsubFn)

      const unsub = InviteList.subscribe(ownerPubkey, mockSubscribe, vi.fn())
      expect(typeof unsub).toBe('function')
      unsub()
      expect(unsubFn).toHaveBeenCalled()
    })
  })

  describe('full handshake', () => {
    it('accept + listen establishes working session', async () => {
      const ownerKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerKey)
      const inviterList = InviteList.create(ownerPubkey)
      const device = createDeviceEntry()
      inviterList.addDevice(device)

      const inviteeKey = generateSecretKey()
      const inviteePubkey = getPublicKey(inviteeKey)

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

      let inviterSession: any

      // Inviter listens
      inviterList.listen({
        deviceId: device.deviceId,
        ownerPrivateKey: ownerKey,
        nostrSubscribe: createSubscribe(),
        onSession: (session) => {
          inviterSession = session
        },
      })

      // Invitee accepts
      const { session: inviteeSession, event: acceptEvent } = await inviterList.accept({
        deviceId: device.deviceId,
        inviteePublicKey: inviteePubkey,
        inviteePrivateKey: inviteeKey,
        nostrSubscribe: createSubscribe(),
      })

      messageQueue.push(acceptEvent)

      // Wait for session
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(inviterSession).toBeDefined()

      // Test bidirectional messaging
      const inviteeMessages = createEventStream(inviteeSession)
      const inviterMessages = createEventStream(inviterSession)

      // Invitee sends first (initiator)
      messageQueue.push(inviteeSession.send('Hello from invitee!').event)
      const msg1 = await inviterMessages.next()
      expect(msg1.value?.content).toBe('Hello from invitee!')

      // Inviter replies
      messageQueue.push(inviterSession.send('Hello from inviter!').event)
      const msg2 = await inviteeMessages.next()
      expect(msg2.value?.content).toBe('Hello from inviter!')
    })
  })
})
