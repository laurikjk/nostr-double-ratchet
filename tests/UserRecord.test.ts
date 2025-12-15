import { describe, it, expect, vi } from "vitest"
import {
  UserRecord,
  StoredUserRecord,
  createUserRecord,
  getOrCreateDevice,
  serializeUserRecord,
  deserializeUserRecord,
} from "../src/UserRecord"
import { createDeviceRecord } from "../src/DeviceRecord"
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

describe("UserRecord", () => {
  describe("createUserRecord", () => {
    it("creates user record with public key", () => {
      const record = createUserRecord("pubkey123")

      expect(record.publicKey).toBe("pubkey123")
      expect(record.devices.size).toBe(0)
    })

    it("creates empty devices map", () => {
      const record = createUserRecord("pubkey123")

      expect(record.devices).toBeInstanceOf(Map)
      expect(record.devices.size).toBe(0)
    })
  })

  describe("getOrCreateDevice", () => {
    it("creates new device if not exists", () => {
      const user = createUserRecord("pub1")
      const device = getOrCreateDevice(user, "device1")

      expect(device.deviceId).toBe("device1")
      expect(user.devices.has("device1")).toBe(true)
    })

    it("returns existing device if exists", () => {
      const user = createUserRecord("pub1")
      const device1 = getOrCreateDevice(user, "device1")
      const device2 = getOrCreateDevice(user, "device1")

      expect(device1).toBe(device2)
    })

    it("can create multiple devices", () => {
      const user = createUserRecord("pub1")
      getOrCreateDevice(user, "device1")
      getOrCreateDevice(user, "device2")
      getOrCreateDevice(user, "device3")

      expect(user.devices.size).toBe(3)
    })
  })

  describe("serializeUserRecord", () => {
    it("serializes empty user record", () => {
      const user = createUserRecord("pub1")
      const serialized = serializeUserRecord(user)

      expect(serialized.publicKey).toBe("pub1")
      expect(serialized.devices).toEqual([])
    })

    it("serializes user record with devices", () => {
      const user = createUserRecord("pub1")
      getOrCreateDevice(user, "d1")
      getOrCreateDevice(user, "d2")

      const serialized = serializeUserRecord(user)

      expect(serialized.devices).toHaveLength(2)
      expect(serialized.devices.map((d) => d.deviceId).sort()).toEqual(["d1", "d2"])
    })

    it("serializes user record with device sessions", () => {
      const user = createUserRecord("pub1")
      const device = getOrCreateDevice(user, "d1")
      device.activeSession = createMockSession("s1")

      const serialized = serializeUserRecord(user)

      expect(serialized.devices[0].activeSession).not.toBeNull()
    })
  })

  describe("deserializeUserRecord", () => {
    it("deserializes empty user record", () => {
      const stored: StoredUserRecord = {
        publicKey: "pub1",
        devices: [],
      }

      const mockSubscribe = vi.fn()
      const record = deserializeUserRecord(stored, mockSubscribe)

      expect(record.publicKey).toBe("pub1")
      expect(record.devices.size).toBe(0)
    })

    it("round-trips through serialize/deserialize", () => {
      const original = createUserRecord("pub1")
      const device1 = getOrCreateDevice(original, "d1")
      device1.activeSession = createMockSession("s1")
      const device2 = getOrCreateDevice(original, "d2")
      device2.staleAt = 12345

      const serialized = serializeUserRecord(original)
      const mockSubscribe = vi.fn()
      const deserialized = deserializeUserRecord(serialized, mockSubscribe)

      expect(deserialized.publicKey).toBe(original.publicKey)
      expect(deserialized.devices.size).toBe(2)
      expect(deserialized.devices.get("d1")?.activeSession).toBeDefined()
      expect(deserialized.devices.get("d2")?.staleAt).toBe(12345)
    })
  })
})
