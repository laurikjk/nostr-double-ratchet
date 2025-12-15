import { describe, it, expect, vi, beforeEach } from "vitest"
import { UserRecordStore } from "../src/UserRecordStore"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { Session } from "../src/Session"
import { SessionState } from "../src/types"
import { getOrCreateDevice } from "../src/UserRecord"

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

describe("UserRecordStore", () => {
  describe("in-memory operations", () => {
    let store: UserRecordStore

    beforeEach(() => {
      store = new UserRecordStore()
    })

    describe("getOrCreate", () => {
      it("creates new user record", () => {
        const user = store.getOrCreate("pub1")

        expect(user.publicKey).toBe("pub1")
        expect(user.devices.size).toBe(0)
      })

      it("returns same record on subsequent calls", () => {
        const user1 = store.getOrCreate("pub1")
        const user2 = store.getOrCreate("pub1")

        expect(user1).toBe(user2)
      })

      it("creates different records for different keys", () => {
        const user1 = store.getOrCreate("pub1")
        const user2 = store.getOrCreate("pub2")

        expect(user1).not.toBe(user2)
        expect(user1.publicKey).toBe("pub1")
        expect(user2.publicKey).toBe("pub2")
      })
    })

    describe("get", () => {
      it("returns undefined for unknown user", () => {
        expect(store.get("unknown")).toBeUndefined()
      })

      it("returns user after creation", () => {
        store.getOrCreate("pub1")

        expect(store.get("pub1")).toBeDefined()
        expect(store.get("pub1")?.publicKey).toBe("pub1")
      })
    })

    describe("delete", () => {
      it("removes user record", () => {
        store.getOrCreate("pub1")
        store.delete("pub1")

        expect(store.get("pub1")).toBeUndefined()
      })

      it("does nothing for non-existent user", () => {
        store.delete("nonexistent")
        // Should not throw
      })
    })

    describe("getAll", () => {
      it("returns empty map initially", () => {
        const all = store.getAll()

        expect(all.size).toBe(0)
      })

      it("returns all user records", () => {
        store.getOrCreate("pub1")
        store.getOrCreate("pub2")

        const all = store.getAll()

        expect(all.size).toBe(2)
        expect(all.has("pub1")).toBe(true)
        expect(all.has("pub2")).toBe(true)
      })
    })

    describe("has", () => {
      it("returns false for unknown user", () => {
        expect(store.has("unknown")).toBe(false)
      })

      it("returns true for existing user", () => {
        store.getOrCreate("pub1")

        expect(store.has("pub1")).toBe(true)
      })
    })
  })

  describe("persistence", () => {
    let store: UserRecordStore
    let storage: InMemoryStorageAdapter
    const mockSubscribe = vi.fn()

    beforeEach(() => {
      storage = new InMemoryStorageAdapter()
      store = new UserRecordStore(storage, "v1")
    })

    describe("storageKey", () => {
      it("generates correct key format", () => {
        expect(store.storageKey("pub1")).toBe("v1/user/pub1")
      })

      it("generates correct key prefix", () => {
        expect(store.storageKeyPrefix()).toBe("v1/user/")
      })
    })

    describe("save", () => {
      it("persists user record to storage", async () => {
        store.getOrCreate("pub1")
        await store.save("pub1")

        const stored = await storage.get("v1/user/pub1")
        expect(stored).toBeDefined()
      })

      it("does nothing for non-existent user", async () => {
        await store.save("nonexistent")
        const stored = await storage.get("v1/user/nonexistent")
        expect(stored).toBeUndefined()
      })
    })

    describe("load", () => {
      it("loads user record from storage", async () => {
        // Create and save a user
        const user = store.getOrCreate("pub1")
        const device = getOrCreateDevice(user, "d1")
        device.activeSession = createMockSession("s1")
        await store.save("pub1")

        // Create fresh store and load
        const freshStore = new UserRecordStore(storage, "v1")
        await freshStore.load("pub1", mockSubscribe)

        expect(freshStore.get("pub1")).toBeDefined()
        expect(freshStore.get("pub1")?.devices.get("d1")?.activeSession).toBeDefined()
      })

      it("does nothing for non-existent user", async () => {
        await store.load("nonexistent", mockSubscribe)
        expect(store.get("nonexistent")).toBeUndefined()
      })
    })

    describe("loadAll", () => {
      it("loads all user records from storage", async () => {
        store.getOrCreate("pub1")
        store.getOrCreate("pub2")
        await store.save("pub1")
        await store.save("pub2")

        const freshStore = new UserRecordStore(storage, "v1")
        await freshStore.loadAll(mockSubscribe)

        expect(freshStore.getAll().size).toBe(2)
        expect(freshStore.has("pub1")).toBe(true)
        expect(freshStore.has("pub2")).toBe(true)
      })
    })

    describe("deleteFromStorage", () => {
      it("removes user record from storage", async () => {
        store.getOrCreate("pub1")
        await store.save("pub1")

        await store.deleteFromStorage("pub1")

        const stored = await storage.get("v1/user/pub1")
        expect(stored).toBeUndefined()
      })
    })
  })
})
