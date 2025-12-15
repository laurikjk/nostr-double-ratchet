import {
  UserRecord,
  StoredUserRecord,
  createUserRecord,
  serializeUserRecord,
  deserializeUserRecord,
} from "./UserRecord"
import { StorageAdapter } from "./StorageAdapter"
import { NostrSubscribe } from "./types"

export class UserRecordStore {
  private records: Map<string, UserRecord> = new Map()
  private readonly keyPrefix: string

  constructor(
    private storage?: StorageAdapter,
    versionPrefix: string = "v1"
  ) {
    this.keyPrefix = `${versionPrefix}/user/`
  }

  // Storage key methods
  storageKey(publicKey: string): string {
    return `${this.keyPrefix}${publicKey}`
  }

  storageKeyPrefix(): string {
    return this.keyPrefix
  }

  // In-memory operations
  getOrCreate(publicKey: string): UserRecord {
    let record = this.records.get(publicKey)
    if (!record) {
      record = createUserRecord(publicKey)
      this.records.set(publicKey, record)
    }
    return record
  }

  get(publicKey: string): UserRecord | undefined {
    return this.records.get(publicKey)
  }

  has(publicKey: string): boolean {
    return this.records.has(publicKey)
  }

  delete(publicKey: string): void {
    this.records.delete(publicKey)
  }

  getAll(): Map<string, UserRecord> {
    return this.records
  }

  // Persistence operations
  async save(publicKey: string): Promise<void> {
    if (!this.storage) return
    const userRecord = this.records.get(publicKey)
    if (!userRecord) return
    const data = serializeUserRecord(userRecord)
    await this.storage.put(this.storageKey(publicKey), data)
  }

  async load(publicKey: string, nostrSubscribe: NostrSubscribe): Promise<void> {
    if (!this.storage) return
    const data = await this.storage.get<StoredUserRecord>(this.storageKey(publicKey))
    if (!data) return
    const userRecord = deserializeUserRecord(data, nostrSubscribe)
    this.records.set(publicKey, userRecord)
  }

  async loadAll(nostrSubscribe: NostrSubscribe): Promise<void> {
    if (!this.storage) return
    const keys = await this.storage.list(this.keyPrefix)
    await Promise.all(
      keys.map((key) => {
        const publicKey = key.slice(this.keyPrefix.length)
        return this.load(publicKey, nostrSubscribe)
      })
    )
  }

  async deleteFromStorage(publicKey: string): Promise<void> {
    if (!this.storage) return
    await this.storage.del(this.storageKey(publicKey))
  }
}
