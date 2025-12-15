import { describe, it, expect, vi } from "vitest"
import {
  StoredDeviceRecord,
  createDeviceRecord,
  serializeDeviceRecord,
  deserializeDeviceRecord,
  rotateSession,
} from "../src/DeviceRecord"
import { Session } from "../src/Session"
import { SessionState } from "../src/types"

const createMockSessionState = (name: string): SessionState => {
  return {
    rootKey: new Uint8Array(32),
    theirCurrentNostrPublicKey: "their-current-" + name,
    theirNextNostrPublicKey: "their-next-" + name,
    ourCurrentNostrKey: {
      publicKey: "our-current-pub-" + name,
      privateKey: new Uint8Array(32),
    },
    ourNextNostrKey: {
      publicKey: "our-next-pub-" + name,
      privateKey: new Uint8Array(32),
    },
    receivingChainKey: new Uint8Array(32),
    sendingChainKey: new Uint8Array(32),
    sendingChainMessageNumber: 0,
    receivingChainMessageNumber: 0,
    previousSendingChainMessageCount: 0,
    skippedKeys: {},
  }
}

const createMockSession = (name: string) => {
  const state = createMockSessionState(name)
  return {
    name,
    state,
  } as unknown as Session
}

describe("DeviceRecord", () => {
  describe("createDeviceRecord", () => {
    it("creates device record with deviceId", () => {
      const record = createDeviceRecord("device-1")

      expect(record.deviceId).toBe("device-1")
      expect(record.inactiveSessions).toEqual([])
      expect(record.activeSession).toBeUndefined()
      expect(record.staleAt).toBeUndefined()
    })

    it("sets createdAt to current time", () => {
      const before = Date.now()
      const record = createDeviceRecord("device-1")
      const after = Date.now()

      expect(record.createdAt).toBeGreaterThanOrEqual(before)
      expect(record.createdAt).toBeLessThanOrEqual(after)
    })
  })

  describe("serializeDeviceRecord", () => {
    it("serializes device record with no sessions", () => {
      const record = createDeviceRecord("device-1")
      const serialized = serializeDeviceRecord(record)

      expect(serialized.deviceId).toBe("device-1")
      expect(serialized.activeSession).toBeNull()
      expect(serialized.inactiveSessions).toEqual([])
      expect(serialized.createdAt).toBe(record.createdAt)
      expect(serialized.staleAt).toBeUndefined()
    })

    it("serializes device record with active session", () => {
      const record = createDeviceRecord("device-1")
      record.activeSession = createMockSession("session-1")

      const serialized = serializeDeviceRecord(record)

      expect(serialized.activeSession).not.toBeNull()
      // activeSession is serialized as JSON string
      expect(typeof serialized.activeSession).toBe("string")
      const parsed = JSON.parse(serialized.activeSession!)
      expect(parsed.ourNextNostrKey.publicKey).toBe("our-next-pub-session-1")
    })

    it("serializes device record with inactive sessions", () => {
      const record = createDeviceRecord("device-1")
      record.inactiveSessions = [
        createMockSession("session-1"),
        createMockSession("session-2"),
      ]

      const serialized = serializeDeviceRecord(record)

      expect(serialized.inactiveSessions).toHaveLength(2)
    })

    it("serializes staleAt when present", () => {
      const record = createDeviceRecord("device-1")
      record.staleAt = 1234567890

      const serialized = serializeDeviceRecord(record)

      expect(serialized.staleAt).toBe(1234567890)
    })
  })

  describe("deserializeDeviceRecord", () => {
    it("deserializes device record with no sessions", () => {
      const stored: StoredDeviceRecord = {
        deviceId: "device-1",
        activeSession: null,
        inactiveSessions: [],
        createdAt: 1234567890,
      }

      const mockSubscribe = vi.fn()
      const record = deserializeDeviceRecord(stored, mockSubscribe)

      expect(record.deviceId).toBe("device-1")
      expect(record.activeSession).toBeUndefined()
      expect(record.inactiveSessions).toEqual([])
      expect(record.createdAt).toBe(1234567890)
    })

    it("round-trips through serialize/deserialize", () => {
      const original = createDeviceRecord("device-1")
      original.activeSession = createMockSession("session-1")
      original.inactiveSessions = [createMockSession("session-2")]
      original.staleAt = 9999

      const serialized = serializeDeviceRecord(original)
      const mockSubscribe = vi.fn()
      const deserialized = deserializeDeviceRecord(serialized, mockSubscribe)

      expect(deserialized.deviceId).toBe(original.deviceId)
      expect(deserialized.createdAt).toBe(original.createdAt)
      expect(deserialized.staleAt).toBe(original.staleAt)
      expect(deserialized.activeSession).toBeDefined()
      // Check session state was preserved
      expect(deserialized.activeSession?.state.ourNextNostrKey.publicKey).toBe("our-next-pub-session-1")
      expect(deserialized.inactiveSessions).toHaveLength(1)
      expect(deserialized.inactiveSessions[0].state.ourNextNostrKey.publicKey).toBe("our-next-pub-session-2")
    })
  })

  describe("rotateSession", () => {
    it("sets active session when none exists", () => {
      const record = createDeviceRecord("d1")
      const session = createMockSession("s1")

      rotateSession(record, session)

      expect(record.activeSession).toBe(session)
      expect(record.inactiveSessions).toHaveLength(0)
    })

    it("moves current active to inactive when rotating", () => {
      const record = createDeviceRecord("d1")
      const session1 = createMockSession("s1")
      const session2 = createMockSession("s2")

      rotateSession(record, session1)
      rotateSession(record, session2)

      expect(record.activeSession).toBe(session2)
      expect(record.inactiveSessions).toContain(session1)
    })

    it("does not duplicate if same session rotated", () => {
      const record = createDeviceRecord("d1")
      const session = createMockSession("s1")

      rotateSession(record, session)
      rotateSession(record, session)

      expect(record.activeSession).toBe(session)
      expect(record.inactiveSessions).toHaveLength(0)
    })

    it("keeps max 1 inactive session", () => {
      const record = createDeviceRecord("d1")
      const s1 = createMockSession("s1")
      const s2 = createMockSession("s2")
      const s3 = createMockSession("s3")

      rotateSession(record, s1)
      rotateSession(record, s2)
      rotateSession(record, s3)

      expect(record.activeSession).toBe(s3)
      expect(record.inactiveSessions).toHaveLength(1)
      expect(record.inactiveSessions[0]).toBe(s2)
    })

    it("does not move to inactive if session has same name", () => {
      const record = createDeviceRecord("d1")
      const session1 = createMockSession("s1")
      const session1Updated = createMockSession("s1") // Same name, different object

      rotateSession(record, session1)
      rotateSession(record, session1Updated)

      expect(record.activeSession).toBe(session1Updated)
      expect(record.inactiveSessions).toHaveLength(0)
    })
  })
})
